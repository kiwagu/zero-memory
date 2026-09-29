#!/usr/bin/env bash
# Drop this stack's older release images from the host. Every release pulls
# its images onto the same disk and nothing else takes them away, so without
# this the disk fills up and a later pull dies half-way. Run ON the host by
# upgrade.sh, before the pull.
#
# Usage:
#   infra/prod/scripts/prune-images.sh <release-tag>
#
# For each of the stack's images (${ZM_IMAGE_PREFIX}zero-memory-server, -web
# and -docs) it keeps ZM_KEEP_RELEASES releases, 5 when unset or not a
# positive whole number:
#   - the release being deployed, <release-tag>;
#   - the newest other releases, up to that count: the one being replaced and
#     those before it stay, so a rollback to them needs no registry;
# and, whatever the count, any tag a container, running or stopped, was
# created from.
# Only tags that read as a release version (X.Y.Z) are considered. Anything
# else, such as `latest` or a local build, is left alone, and so is every
# repository outside the prefix.
set -euo pipefail

release="${1:?usage: prune-images.sh <release-tag>}"
prefix="${ZM_IMAGE_PREFIX:-}"
keep="${ZM_KEEP_RELEASES:-5}"
if ! [[ "$keep" =~ ^[1-9][0-9]*$ ]]; then
  echo "  ZM_KEEP_RELEASES=${keep} is not a positive whole number; keeping 5" >&2
  keep=5
fi

present=()
for service in server web docs; do
  repository="${prefix}zero-memory-${service}"
  while IFS= read -r tag; do
    if [[ "$tag" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      present+=("${repository}:${tag}")
    fi
  done < <(docker image ls "$repository" --format '{{.Tag}}')
done

# Version order, not text order: 0.10.0 is newer than 0.9.0.
kept_others="$(
  for image in "${present[@]}"; do printf '%s\n' "${image##*:}"; done \
    | grep -vxF "$release" | sort -uV | tail -n "$((keep - 1))" || true
)"
in_use="$(docker ps -a --format '{{.Image}}')"

removed=0
for image in "${present[@]}"; do
  version="${image##*:}"
  if [ "$version" = "$release" ] || grep -qxF "$version" <<<"$kept_others"; then
    continue
  fi
  if grep -qxF "$image" <<<"$in_use"; then
    echo "  keeping ${image}: a container was created from it"
    continue
  fi
  if docker image rm "$image" >/dev/null; then
    removed=$((removed + 1))
  else
    echo "  could not remove ${image}" >&2
  fi
done

others="$(grep -c . <<<"$kept_others" || true)"
echo "→ release images: kept ${release} and ${others} other(s), removed ${removed}"
