#!/bin/sh
# Sets up the camera helper: the ball model, a Python environment with OpenCV and onnxruntime in
# ./.venv, and "Juggle Break Camera.app", the app the helper runs inside so macOS can grant it the
# camera. The plugin runs this itself the first time a break starts; running it again redoes only
# what is missing.
set -e
cd "$(dirname "$0")"
# The desktop app starts this with a short PATH; look where Python, uv and Homebrew usually are too.
PATH="$HOME/.local/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
REPO=${JUGGLE_REPO:-jamiepinheiro/juggle_tracker}
MODEL_RELEASE=r3

# The model: in a clone of the repo, its model/ folder's current release; in an installed copy,
# the release this plugin was made for, downloaded from GitHub.
if [ -x ../model/fetch.sh ]; then
  ../model/fetch.sh
elif [ ! -s model/ball.onnx ]; then
  echo "juggle-break: downloading the ball model ($MODEL_RELEASE)"
  rm -f model/ball.onnx
  curl -fsSL -o model/ball.onnx.part "https://github.com/$REPO/releases/download/model-$MODEL_RELEASE/ball.onnx"
  mv model/ball.onnx.part model/ball.onnx
fi

# Python 3.11+: uv brings its own when it is installed; otherwise the newest one found.
if ! .venv/bin/python -c "import cv2, numpy, onnxruntime" 2>/dev/null; then
  rm -rf .venv
  if command -v uv >/dev/null; then
    echo "juggle-break: creating the Python environment with uv"
    uv venv --quiet --python 3.12 .venv
    uv pip install --quiet --python .venv/bin/python -r helper/requirements.txt
  else
    PY=
    for p in python3.13 python3.12 python3.11 python3; do
      if command -v "$p" >/dev/null && "$p" -c 'import sys; sys.exit(sys.version_info < (3, 11))' 2>/dev/null; then
        PY=$p
        break
      fi
    done
    if [ -z "$PY" ]; then
      echo "juggle-break: needs Python 3.11 or later. Install uv (https://docs.astral.sh/uv/) or run: brew install python@3.12" >&2
      exit 1
    fi
    echo "juggle-break: creating the Python environment with $PY"
    "$PY" -m venv .venv
    .venv/bin/pip install --quiet --upgrade pip
    .venv/bin/pip install --quiet -r helper/requirements.txt
  fi
fi

# The camera app: a launcher compiled from camera-app/, signed for this Mac.
app="Juggle Break Camera.app"
if [ ! -x "$app/Contents/MacOS/launcher" ] || [ camera-app/launcher.m -nt "$app/Contents/MacOS/launcher" ]; then
  if ! xcrun --find clang >/dev/null 2>&1; then
    echo "juggle-break: needs the Xcode command line tools to build the camera app. Run: xcode-select --install" >&2
    exit 1
  fi
  echo "juggle-break: building $app"
  rm -rf "$app"
  mkdir -p "$app/Contents/MacOS"
  cp camera-app/Info.plist "$app/Contents/Info.plist"
  xcrun clang -fobjc-arc -O2 -mmacosx-version-min=13.0 -framework Foundation -framework AVFoundation \
    camera-app/launcher.m -o "$app/Contents/MacOS/launcher"
  codesign --force --sign - "$app"
fi
chmod +x helper/launch.sh
echo "juggle-break: helper ready"
