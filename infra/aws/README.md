# infra/aws

Runs zero-memory on AWS: the MCP server, the dashboard and the documentation
site on Lambda behind CloudFront, with an existing Supabase project as the
database and auth. It is a second way to deploy, next to `infra/prod` (Docker
Compose on a host); the apps and their images are the same.

An AWS CDK app in TypeScript with three stacks: `zero-memory-<stage>` (the
server), `zero-memory-web-<stage>` (dashboard and docs) and, optionally,
`zero-memory-pipeline-<stage>` (deploys from release tags).

## What it creates

| Resource                                        | Role                                                                                                                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lambda function (container image, 3 GB, x86_64) | The server, from the `runtime-api` target of `apps/server/lambda.Dockerfile`: its own Bun runtime on the Lambda Runtime API, with the embedding model inside the image |
| Function URL (no IAM auth)                      | The function's HTTP entry; it answers only requests that carry the edge header                                                                                         |
| CloudFront distribution + function              | The public address. No caching, every viewer header but `Host` forwarded, `x-origin-verify` added toward the function, `x-viewer-address` set to the caller's address  |
| DynamoDB table + `byOwner` index                | MCP sessions, so consecutive requests of one session can land on different instances; idle sessions expire through TTL                                                 |
| DynamoDB table                                  | The OAuth rate limiter's counts, shared by every instance; expire through TTL                                                                                          |
| Secrets Manager secret                          | The server's environment as JSON (Supabase keys, dashboard URL, model keys), plus the edge header value it generates                                                   |
| SSM parameter                                   | The public URL (OAuth issuer), read by the function at start                                                                                                           |
| CloudWatch log group, alarms, dashboard         | Function logs kept one week; five alarms into one SNS topic; one dashboard (see [Alarms](#alarms))                                                                     |

The web stack holds the dashboard and the docs, each as a Lambda function
from `runtime/web-app.Dockerfile` — the app's own image plus the Lambda Web
Adapter and `runtime/web-app.entry.ts`, which loads the app's secret and SSM
parameters, starts its Next.js server, and answers only requests that carry
the edge header — with a function URL, a secret
(`zero-memory/<stage>/<web|docs>-env`) and a CloudFront distribution that
caches only `/_next/static/*`. Each stack publishes its address in SSM
(`/zero-memory/<stage>/{mcp,web,docs}-url`) and the apps read each other's
at start, so neither stack refers to the other when deployed.

Why the function URL takes no IAM auth: CloudFront's origin access control
signs each request itself, which replaces the client's bearer token, and it
requires every POST to carry a hash of its body, which MCP clients do not
send. The function refuses any request without the header CloudFront adds,
and every MCP request still needs a valid bearer token.

Why the edge sets its own address header: CloudFront forwards a client's
`X-Forwarded-For` and appends the real address after it, so the first hop is
whatever the client wrote. The CloudFront function writes the address
CloudFront saw into `x-viewer-address`, overwriting any value a client sent,
and the function replaces `X-Forwarded-For` with it before the server reads
it. Without that, every request could pick a fresh rate-limit bucket.

## Prerequisites

- An AWS account and a CLI v2 profile that may deploy (CDK bootstrap creates
  IAM roles, so the profile needs IAM rights).
- Docker, Bun, the AWS CLI and `jq` on the machine that deploys: the image is
  built locally, and the script warms the new image up through the CLI.
- A Supabase project with this repository's migrations applied
  (`supabase db push` against it).

## Deploy

From this directory, once per account and region:

```sh
AWS_PROFILE=<profile> bunx cdk bootstrap
```

Then, for a deployment named `stand` (the name is part of every resource):

```sh
AWS_PROFILE=<profile> bash scripts/deploy.sh stand
```

The script builds the images of the server, the dashboard and the docs,
then runs `cdk deploy` for the web stack and the server's, which build the
Lambda images on top of them and push them. The server stack outputs
`McpUrl`, `PublicUrl`, `FunctionUrl`, `FunctionName`, `ServerEnvSecret`,
`SessionTable`, `EdgeDomain` and `AlarmTopic`; the web stack `DashboardUrl`,
`DashboardSecret` and `DocsUrl`.

Last, the script invokes the function directly once with
`{"zeroMemory":"warm-up"}`, and the instance loads the embedding model. The
first read of a new image's model files takes up to a minute; paid here, it
stays off the first search. Only a caller with AWS credentials can invoke the
function directly, so the event cannot come through the function URL.

Options, passed after the stage as CDK context:

| Option                                         | Effect                                                                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `-c memorySize=<MB>`                           | Memory, and with it CPU (default 3008)                                                                                        |
| `-c domainName=<host> -c certificateArn=<arn>` | Serve a host name of your own; the certificate must be in ACM in `us-east-1`. Point the name at `EdgeDomain` (CNAME or alias) |
| `-c alarmEmail=<address>`                      | Mail the alarms there (confirm the subscription from the first mail)                                                          |

```sh
AWS_PROFILE=<profile> bash scripts/deploy.sh stand -c alarmEmail=ops@example.com
```

A custom domain changes the public URL, which is the OAuth issuer: every
client authorized against the old address has to authorize again.

## Configure the apps

Write each app's environment into its secret, from a file of `KEY=value`
lines:

```sh
cat > server.env <<'EOT'
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
EOT
AWS_PROFILE=<profile> bun scripts/server-env.put.ts zero-memory/stand/server-env server.env

cat > web.env <<'EOT'
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
EOT
AWS_PROFILE=<profile> bun scripts/server-env.put.ts zero-memory/stand/web-env web.env
```

The script keeps the keys it does not overwrite, among them the edge header
value. An instance reads its secret once, when it starts, and keeps what it
read. `deploy.sh` stamps each secret's current version into its function
(`ZM_ENV_VERSION`), so the next deploy after a secret changes replaces that
app's instances, and a deploy after no change leaves them running. The server's
`ZM_WEB_URL` and the dashboard's `ZM_SERVER_URL` come from the SSM
parameters, ahead of the secrets.

In the Supabase project's Auth settings, set the site URL to `DashboardUrl`
and add `<DashboardUrl>/**` to the redirect URLs.

## Stage settings

Every `-c key=value` above can live in `stages/<stage>.json` instead (git
ignores the folder: it describes one deployment). `bin/app.ts` reads it for
every deploy of the stage, and the pipeline stack hands it to its builds, so a
pipeline deploy keeps the same domains and mail settings as one by hand. A
`-c` on the command line wins over the file.

## Mail through Amazon SES

With `mailDomain` set (and optionally `mailFrom`, default
`zero-memory <noreply@<mailDomain>>`), the web stack creates an SES identity
for the domain with Easy DKIM, lets the dashboard send through it, and sets
the dashboard's `ZM_MAIL_TRANSPORT=ses` and `ZM_MAIL_FROM`. It outputs three
`MailDkim<n>` records (`<name> CNAME <value>`) for the domain's DNS and the
`MailHookUrl`. Enable the Send Email hook in the Supabase project with that
URL and put the secret Supabase generates into the dashboard's secret as
`ZM_AUTH_HOOK_SECRET`; Auth then sends its mail through the dashboard instead
of SMTP. The SES sandbox delivers only to verified addresses until production
access is granted.

## Deploy from release tags

A second stack runs the same deploy inside the AWS account, from a release
tag pushed to GitHub: CodePipeline takes the tagged commit through a
CodeConnections connection, and CodeBuild applies the database migrations and
runs `scripts/deploy.sh` (`buildspec.yml`). No AWS key leaves AWS; the build's
role can only assume the CDK bootstrap roles, invoke the stage's function for
its warm-up, and read its own secrets.

```sh
AWS_PROFILE=<profile> bunx cdk deploy zero-memory-pipeline-stand \
  -c stage=stand -c githubRepo=<owner>/<repo>
```

Context: `githubRepo` (required), `githubBranch` (default `main`; the
pipeline follows it besides tags), `releaseTags` (comma-separated patterns,
default `v*`), `dockerHubSecret` (a secret with `username` and `token`, when
Docker Hub's anonymous pull limit stops the build).

Then, once:

1. Approve the connection: CodePipeline console → Settings → Connections →
   `zero-memory-<stage>` → Update pending connection. This installs the AWS
   Connector app on the GitHub repository.
2. Put the database URL the migrations go through. CodeBuild has no IPv6, so
   for a Supabase project use the session pooler's address:

   ```sh
   echo 'DATABASE_URL=postgresql://postgres.<ref>:<password>@<pooler-host>:5432/postgres' > db.env
   AWS_PROFILE=<profile> bun scripts/secret-value.put.ts zero-memory/stand/database-url db.env DATABASE_URL
   ```

A pushed tag that matches starts a deploy; the build names the release by the
tag, which `/healthz` then reports.

## Alarms

Five alarms, all in the function's Region, notify one SNS topic:

| Alarm              | Fires when                                                   |
| ------------------ | ------------------------------------------------------------ |
| `InvocationErrors` | an invocation failed or timed out                            |
| `Throttles`        | requests were refused for lack of concurrency                |
| `NearTimeout`      | an invocation ran past 90% of the 60-second timeout          |
| `FailedStarts`     | an instance failed to start (`Runtime.InitError` in the log) |
| `ServerErrors`     | the server answered 5xx three or more times in five minutes  |

The last two count lines of the function's log through metric filters. The
dashboard `zero-memory-<stage>` shows the same metrics. CloudFront's own
metrics live in `us-east-1` and are not watched; a broken edge shows as
silence on the function.

The stack sets no spending limit. Set one for the account (an AWS Budget, or
the spend limit in AWS Settings where the account has one).

## Check it

```sh
curl https://<PublicUrl>/healthz      # 200 and the build version
curl https://<FunctionUrl>/healthz    # 403: the function answers only the edge
```

Point an MCP client at `McpUrl`.

## Limits

- CloudFront ends a response that takes longer than 60 seconds, so the
  function's timeout is 60 seconds too.
- The first request an instance serves pays for loading the server, and its
  first search for loading the embedding model (seconds).
- Background writes started by a request (usage metering, audit) finish before
  its response is returned, because Lambda freezes the instance afterwards.

## Remove

```sh
AWS_PROFILE=<profile> bunx cdk destroy zero-memory-stand zero-memory-web-stand -c stage=stand
```

This deletes the functions, the tables, the secrets, the parameters, the
alarms and the logs; `bunx cdk destroy zero-memory-pipeline-stand -c stage=stand -c
githubRepo=<owner>/<repo>` removes the pipeline. The CDK bootstrap stack and
the images it pushed stay.
