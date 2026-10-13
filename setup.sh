#!/bin/sh
# Creates the helper's Python environment (camera, detector, counter) in ./.venv and builds
# "Juggle Break Camera.app", the app the helper runs inside so macOS can grant it the camera.
set -e
cd "$(dirname "$0")"
PY=$(command -v python3.11 || command -v python3.12 || command -v python3.13 || command -v python3)
"$PY" -m venv .venv
.venv/bin/pip install --quiet --upgrade pip
.venv/bin/pip install --quiet -r helper/requirements.txt

app="Juggle Break Camera.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp camera-app/Info.plist "$app/Contents/Info.plist"
clang -fobjc-arc -O2 -mmacosx-version-min=13.0 -framework Foundation -framework AVFoundation \
  camera-app/launcher.m -o "$app/Contents/MacOS/launcher"
codesign --force --sign - "$app"
chmod +x helper/launch.sh
echo "juggle-break: helper ready"
