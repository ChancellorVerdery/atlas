#!/usr/bin/env bash
# Build the web bundle, then the app. The dist/ folder is a folder reference in
# the Xcode project, so the web build MUST run first or Xcode ships stale (or
# no) assets.
#
#   ./build.sh mac       release macOS app -> build/Build/Products/Release/Atlas.app
#   ./build.sh ios-sim   iOS Simulator build (compile + install-able in a sim)
#   ./build.sh smoke     debug macOS build + headless self-check (no window)
set -euo pipefail
cd "$(dirname "$0")"

(cd ../atlas-ui && npm run build && node scripts/gen-manifest.mjs)

# Xcode copies dist/ as a FOLDER REFERENCE, and that copy is additive: a file
# deleted from dist/ stays in the previously built .app forever. That is how a
# retired public/gym-import.json — deleted for destroying real workout history —
# kept shipping inside the app after the repo no longer had it, with the bundle
# serving a file its own manifest didn't list. Drop the copied dist so every
# build re-copies it exactly; object files are untouched, so this is cheap.
find build build-device build-test -type d -path '*/Atlas.app/*' -name dist -prune -exec rm -rf {} + 2>/dev/null || true

case "${1:-mac}" in
  mac)
    xcodebuild -project Atlas.xcodeproj -scheme Atlas -configuration Release \
      -destination 'platform=macOS' -derivedDataPath build -quiet build
    echo "built: $(pwd)/build/Build/Products/Release/Atlas.app"
    ;;
  ios-sim)
    xcodebuild -project Atlas.xcodeproj -scheme Atlas \
      -destination 'generic/platform=iOS Simulator' -derivedDataPath build -quiet build
    echo "built: $(pwd)/build/Build/Products/Debug-iphonesimulator/Atlas.app"
    ;;
  smoke)
    xcodebuild -project Atlas.xcodeproj -scheme Atlas \
      -destination 'platform=macOS' -derivedDataPath build -quiet build
    # ATLAS_REPO points the sidecar at this checkout (the app defaults to the
    # main checkout at ~/Desktop/Atlas V4, which may not have standalone.mjs yet)
    ATLAS_REPO="$(cd ../atlas-ui && pwd)" \
      ./build/Build/Products/Debug/Atlas.app/Contents/MacOS/Atlas --smoke
    ;;
  *)
    echo "usage: $0 [mac|ios-sim|smoke]" >&2
    exit 2
    ;;
esac
