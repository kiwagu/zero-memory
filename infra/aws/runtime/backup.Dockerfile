# The database backup as an AWS Lambda container image: the container host's
# own dump script, unchanged, with the Postgres client it runs, and
# backup.entry.ts, which runs it per invocation and keeps the artifacts in S3.
#
#   docker build -f infra/aws/runtime/backup.Dockerfile .
#
# Built from the repository root: the script lives in infra/prod/scripts.

ARG BUN_VERSION=1.3.11

# The AWS SDK clients the entry needs.
FROM oven/bun:${BUN_VERSION}-alpine AS sdk
WORKDIR /opt/zm-backup
RUN bun add @aws-sdk/client-s3@3.1140.0 @aws-sdk/client-secrets-manager@3.1140.0

FROM oven/bun:${BUN_VERSION}-alpine
# pg_dump refuses to dump a server newer than itself; the managed projects run
# Postgres 17. coreutils for the script's stat, sha256sum and date flags.
RUN apk add --no-cache bash coreutils gzip postgresql17-client
WORKDIR /opt/zm-backup
COPY --from=sdk /opt/zm-backup/node_modules ./node_modules
COPY infra/prod/scripts/db-dump.sh ./db-dump.sh
COPY infra/aws/runtime/backup.entry.ts ./entry.ts
USER bun
ENV HOME=/tmp
ENTRYPOINT ["bun", "/opt/zm-backup/entry.ts"]
