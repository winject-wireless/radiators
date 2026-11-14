#!/usr/bin/env bash
# Reuse openEMS Docker image artifacts keyed by the Dockerfile checksum.
# On cache miss (including first run or expired artifact), build and upload once.
set -euo pipefail
: "${GH_TOKEN:?Set GH_TOKEN to github.token with actions:read}"
: "${GITHUB_REPOSITORY:?}"
: "${GITHUB_OUTPUT:?}"
digest="$(sha256sum docker/openems/Dockerfile | cut -d" " -f1)"
name="openems-image-${digest}"
echo "artifact_name=$name" >> "$GITHUB_OUTPUT"
echo "Searching reusable image artifact: $name"
id="$(gh api --paginate "repos/${GITHUB_REPOSITORY}/actions/artifacts?per_page=100" | jq -rs --arg name "$name" '[.[].artifacts[]? | select(.name == $name and .expired == false)] | sort_by(.created_at) | reverse | .[0].id // empty')"
if [[ -n "$id" && "$id" != "null" ]]; then
  echo "Restoring Docker image from artifact ID $id"
  curl --fail --silent --show-error --location --retry 3 \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/artifacts/${id}/zip" \
    -o /tmp/openems-artifact.zip
  unzip -p /tmp/openems-artifact.zip openems-image.tar.zst | zstd -dc | docker load
  docker image inspect radiators-openems:ci >/dev/null
  echo "cache_hit=true" >> "$GITHUB_OUTPUT"
  echo "Loaded prebuilt Docker image."
else
  echo "No matching image artifact. Bootstrapping image ONCE."
  docker build --progress=plain -t radiators-openems:ci -f docker/openems/Dockerfile .
  docker save radiators-openems:ci | zstd -T2 -3 -o openems-image.tar.zst
  echo "cache_hit=false" >> "$GITHUB_OUTPUT"
  echo "The workflow uploads this image for subsequent runs."
fi
