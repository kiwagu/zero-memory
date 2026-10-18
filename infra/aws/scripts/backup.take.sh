#!/usr/bin/env bash
# Takes one database backup of a stage now and waits until it is stored.
#
#   AWS_PROFILE=<profile> bash infra/aws/scripts/backup.take.sh [stage]
#
# The pipeline runs it before it applies a release's migrations, so a schema
# change always has a dump from just before it, as on a container host. It
# invokes the stage's own backup function, the one the daily schedule runs,
# and prints what it stored. A stage deployed with backups off, or not
# deployed yet, has no backup function: the script says so and succeeds.
# Needs the AWS CLI.
set -euo pipefail

stage="${1:-stand}"
stack="zero-memory-${stage}"

# A stack that does not exist yet is a first deploy, with nothing to back up.
# Any other failure (a missing permission, a network error) stops the run: a
# skipped backup must never look like a taken one.
if ! function_name="$(aws cloudformation describe-stacks --stack-name "$stack" \
  --query "Stacks[0].Outputs[?OutputKey=='BackupFunctionName'].OutputValue" \
  --output text 2>&1)"; then
  case "$function_name" in
    *"does not exist"*)
      echo "backup: ${stack} is not deployed yet, so there is nothing to back up"
      exit 0
      ;;
  esac
  echo "$function_name" >&2
  exit 1
fi
if [ -z "$function_name" ] || [ "$function_name" = None ]; then
  echo "backup: ${stack} runs without backups, so none was taken"
  exit 0
fi

answer="$(mktemp)"
trap 'rm -f "$answer"' EXIT
# The function runs for up to 15 minutes. It answers with what it stored, and
# an error it throws arrives as FunctionError with the invocation itself
# reported as a success.
error="$(aws lambda invoke --function-name "$function_name" \
  --cli-read-timeout 900 --query FunctionError --output text "$answer")"
if [ "$error" != None ]; then
  echo "backup failed (${error}): $(cat "$answer")" >&2
  exit 1
fi
echo "backup: $(cat "$answer")"
