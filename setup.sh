#!/bin/sh
# Creates the helper's Python environment (camera, detector, counter) in ./.venv.
set -e
cd "$(dirname "$0")"
PY=$(command -v python3.11 || command -v python3.12 || command -v python3.13 || command -v python3)
"$PY" -m venv .venv
.venv/bin/pip install --quiet --upgrade pip
.venv/bin/pip install --quiet -r helper/requirements.txt
echo "juggle-break: helper ready"
