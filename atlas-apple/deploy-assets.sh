#!/usr/bin/env bash
# Ship the built web bundle to the Atlas server so the native apps self-update:
# builds dist/, stamps manifest.json, and unpacks into ~/atlas-backend/app-dist.
# The uiapi container bind-mounts that dir read-only and reads per request, so
# the deploy is live immediately, no restart.
#
# Files are updated IN PLACE (a dir swap would strand Docker's bind mount on
# the old inode), assets first and manifest.json last — a device updating mid-
# deploy either sees the old manifest (fine) or the new one with all its files
# already present. If it somehow catches a torn file, the sha256 check aborts
# that update and it retries on the next kick.
# ponytail: assets from retired builds accumulate in app-dist; harmless (a few
# MB) — add a manifest-aware sweep if it ever matters.
#
# Run from anywhere:  bash atlas-apple/deploy-assets.sh
set -euo pipefail
HOST=${ATLAS_SSH_HOST:-atlas}
cd "$(dirname "$0")/../atlas-ui"

npm run build
node scripts/gen-manifest.mjs

# If the stack came up before the first deploy, dockerd auto-created app-dist
# as root:root and our non-root tar would fail every write. Take ownership
# (no-op once we already own it); the box runs docker under sudo anyway.
ssh "$HOST" 'mkdir -p ~/atlas-backend/app-dist && [ -w ~/atlas-backend/app-dist ] || sudo chown -R "$(id -u):$(id -g)" ~/atlas-backend/app-dist'
# macOS bsdtar embeds com.apple.* xattr headers GNU tar doesn't recognise;
# --warning=no-unknown-keyword silences the (harmless) extract-side grumble.
tar -C dist --exclude manifest.json -czf - . | ssh "$HOST" 'tar --warning=no-unknown-keyword -xzf - -C ~/atlas-backend/app-dist'
scp -q dist/manifest.json "$HOST:atlas-backend/app-dist/manifest.json"

echo "deployed: $(node -e 'console.log(JSON.parse(require("fs").readFileSync("dist/manifest.json")).version)')"
