# infra/aws

Runs the zero-memory MCP server on AWS Lambda behind CloudFront, with an
existing Supabase project as its database and auth. It is a second way to
deploy the server, next to `infra/prod` (Docker Compose on a host); the
server code is the same.

An AWS CDK app in TypeScript. The dashboard is not part of it.

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

The script builds the server image, then runs `cdk deploy`, which builds the
Lambda image on top of it and pushes it. The stack outputs `McpUrl`,
`PublicUrl`, `FunctionUrl`, `FunctionName`, `ServerEnvSecret`,
`SessionTable`, `EdgeDomain` and `AlarmTopic`.

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

## Configure the server

Write the server's environment into the secret, from a file of `KEY=value`
lines:

```sh
cat > server.env <<'EOT'
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
ZM_WEB_URL=https://<dashboard>
EOT
AWS_PROFILE=<profile> bun scripts/server-env.put.ts zero-memory/stand/server-env server.env
```

The script keeps the keys it does not overwrite, among them the edge header
value. An instance reads the secret once, when it starts; instances already
running keep what they read.

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
AWS_PROFILE=<profile> bunx cdk destroy -c stage=stand
```

This deletes the function, the table, the secret, the parameter and the logs.
The CDK bootstrap stack and the images it pushed stay.
