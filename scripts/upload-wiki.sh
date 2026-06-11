#!/bin/bash
# upload-wiki.sh — ships the omar.os wiki build to bridge-intake (Render).
#
# Tars the static build at dist/blueprint and POSTs it to /wiki-upload on
# bridge-intake, which extracts it onto the service disk and swaps it live
# atomically. The wiki is then served (admin-gated, same cookie as the
# dashboard) at https://bridge-intake.onrender.com/wiki/
#
# Auth: CLOUD_SNAPSHOT_TOKEN from ~/.gbrain/env/system.env (same Bearer
# token the snapshot push uses; it is set on the Render service env).
#
# Usage:
#   ./upload-wiki.sh                       # default build dir
#   WIKI_DIST=/path/to/dist ./upload-wiki.sh
#
# A copy of this script lives in both repos:
#   bridge-cloud-deploy/scripts/upload-wiki.sh   (canonical, next to the server code)
#   omar-os-wiki/scripts/upload-wiki.sh          (convenience copy next to the build)

set -euo pipefail

WIKI_DIST="${WIKI_DIST:-/Users/omar/Documents/_projects/omar-os-wiki/dist/blueprint}"
ENV_FILE="${ENV_FILE:-$HOME/.gbrain/env/system.env}"
ENDPOINT="${WIKI_UPLOAD_URL:-https://bridge-intake.onrender.com/wiki-upload}"

# Sanity: refuse to ship a missing or half-built tree (the builder writes
# index.html plus the life/ and memory/ domains in every complete build).
[ -f "$WIKI_DIST/index.html" ] || { echo "ERROR: no index.html in $WIKI_DIST — build missing or mid-rebuild" >&2; exit 1; }
[ -d "$WIKI_DIST/life" ] || { echo "ERROR: $WIKI_DIST/life missing — build looks incomplete" >&2; exit 1; }
[ -d "$WIKI_DIST/memory" ] || { echo "ERROR: $WIKI_DIST/memory missing — build looks incomplete" >&2; exit 1; }

[ -f "$ENV_FILE" ] || { echo "ERROR: env file not found at $ENV_FILE" >&2; exit 1; }
TOKEN=$(grep -E '^CLOUD_SNAPSHOT_TOKEN=' "$ENV_FILE" | tail -1 | cut -d= -f2-)
[ -n "$TOKEN" ] || { echo "ERROR: CLOUD_SNAPSHOT_TOKEN missing from $ENV_FILE" >&2; exit 1; }

TARBALL=$(mktemp /tmp/omar-os-wiki.XXXXXX).tar.gz
trap 'rm -f "$TARBALL"' EXIT

# COPYFILE_DISABLE keeps macOS AppleDouble (._*) junk out of the tarball.
COPYFILE_DISABLE=1 tar -C "$WIKI_DIST" --exclude='.DS_Store' -czf "$TARBALL" .
echo "tarball: $(du -h "$TARBALL" | cut -f1) from $WIKI_DIST"

HTTP=$(curl -sS -o /tmp/upload-wiki-response.json -w '%{http_code}' \
  -X POST "$ENDPOINT" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/gzip" \
  --data-binary @"$TARBALL")

if [ "$HTTP" = "200" ]; then
  echo "wiki uploaded ($HTTP): $(cat /tmp/upload-wiki-response.json)"
else
  echo "ERROR: wiki upload failed ($HTTP): $(cat /tmp/upload-wiki-response.json)" >&2
  exit 1
fi
