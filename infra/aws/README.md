# infra/aws

Runs the zero-memory MCP server on AWS Lambda behind CloudFront, with an
existing Supabase project as its database and auth. It is a second way to
deploy the server, next to `infra/prod` (Docker Compose on a host); the
server code is the same.

An AWS CDK app in TypeScript. The dashboard is not part of it.

## What it creates

| Resource                                        | Role                                                                                                                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lambda function (container image, 2 GB, x86_64) | The server, from the `runtime-api` target of `apps/server/lambda.Dockerfile`: its own Bun runtime on the Lambda Runtime API, with the embedding model inside the image |
| Function URL (no IAM auth)                      | The function's HTTP entry; it answers only requests that carry the edge header                                                                                         |
| CloudFront distribution                         | The public address. No caching, every viewer header but `Host` forwarded, `x-origin-verify` added toward the function                                                  |
| DynamoDB table + `byOwner` index                | MCP sessions, so consecutive requests of one session can land on different instances; idle sessions expire through TTL                                                 |
| Secrets Manager secret                          | The server's environment as JSON (Supabase keys, dashboard URL), plus the edge header value it generates                                                               |
| SSM parameter                                   | The public URL (OAuth issuer), read by the function at start                                                                                                           |
| CloudWatch log group                            | Function logs, kept one week                                                                                                                                           |

Why the function URL takes no IAM auth: CloudFront's origin access control
signs each request itself, which replaces the client's bearer token, and it
requires every POST to carry a hash of its body, which MCP clients do not
send. The function refuses any request without the header CloudFront adds,
and every MCP request still needs a valid bearer token.

## Prerequisites

- An AWS account and a CLI v2 profile that may deploy (CDK bootstrap creates
  IAM roles, so the profile needs IAM rights).
- Docker and Bun on the machine that deploys: the image is built locally.
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
`PublicUrl`, `FunctionUrl`, `ServerEnvSecret` and `SessionTable`.

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

## Check it

```sh
curl https://<PublicUrl>/healthz      # 200 and the build version
curl https://<FunctionUrl>/healthz    # 403: the function answers only the edge
```

Point an MCP client at `McpUrl`.

## Limits

- CloudFront ends a response that takes longer than 60 seconds, so the
  function's timeout is 60 seconds too.
- The first request an instance serves pays for loading the server and, on its
  first search, about a second for the embedding model.
- Background writes started by a request (usage metering, audit) finish before
  its response is returned, because Lambda freezes the instance afterwards.

## Remove

```sh
AWS_PROFILE=<profile> bunx cdk destroy -c stage=stand
```

This deletes the function, the table, the secret, the parameter and the logs.
The CDK bootstrap stack and the images it pushed stay.
