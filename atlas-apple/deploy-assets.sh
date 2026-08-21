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
# Retired files ARE swept, against the new manifest. This used to be skipped as
# "harmless accumulation (a few MB)" — it was not. public/gym-import.json was
# deleted from the repo because it destroyed real workout history, and because
# deploys only ever wrote files in place, the server kept serving it to any
# device still on an older bundle. A retired asset is not always dead weight;
# sometimes it is the bug.
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

# Sweep anything the new manifest doesn't list. Runs BEFORE the manifest is
# published, so a device either sees the old manifest (whose files are all still
# present — the tar above only added and overwrote) or the new one. No rsync on
# the server, so the keep-list is the manifest's own file list.
node -e 'const m=require("./dist/manifest.json");process.stdout.write(m.files.map(f=>f.path).join("\n"))' \
  | ssh "$HOST" 'cat > /tmp/atlas-keep.txt'
ssh "$HOST" 'python3 - <<"PY"
import os
root = os.path.expanduser("~/atlas-backend/app-dist")
keep = {l.strip() for l in open("/tmp/atlas-keep.txt") if l.strip()}
keep.add("manifest.json")
removed = []
for dirpath, _dirnames, filenames in os.walk(root, topdown=False):
    for fn in filenames:
        full = os.path.join(dirpath, fn)
        rel = os.path.relpath(full, root)
        if rel not in keep:
            os.remove(full)
            removed.append(rel)
    if dirpath != root and not os.listdir(dirpath):
        os.rmdir(dirpath)
print(f"swept {len(removed)} retired file(s)")
for r in removed[:8]:
    print("  -", r)
PY
rm -f /tmp/atlas-keep.txt'

scp -q dist/manifest.json "$HOST:atlas-backend/app-dist/manifest.json"

echo "deployed: $(node -e 'console.log(JSON.parse(require("fs").readFileSync("dist/manifest.json")).version)')"
