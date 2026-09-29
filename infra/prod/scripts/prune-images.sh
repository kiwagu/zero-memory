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
# and -docs) it keeps:
#   - the release being deployed, <release-tag>;
#   - the newest other release: normally the one being replaced, which stays
#     so a rollback to it needs no registry;
#   - any tag a container, running or stopped, was created from.
# Only tags that read as a release version (X.Y.Z) are considered. Anything
# else, such as `latest` or a local build, is left alone, and so is every
# repository outside the prefix.
set -euo pipefail

release="${1:?usage: prune-images.sh <release-tag>}"
prefix="${ZM_IMAGE_PREFIX:-}"

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
newest_other="$(
  for image in "${present[@]}"; do printf '%s\n' "${image##*:}"; done \
    | grep -vxF "$release" | sort -uV | tail -1 || true
)"
in_use="$(docker ps -a --format '{{.Image}}')"

removed=0
for image in "${present[@]}"; do
  version="${image##*:}"
  if [ "$version" = "$release" ] || [ "$version" = "$newest_other" ]; then
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

echo "→ release images: kept ${release}${newest_other:+ and ${newest_other}}, removed ${removed}"
