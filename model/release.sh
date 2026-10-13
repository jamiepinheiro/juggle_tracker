#!/bin/sh
# Publishes a model release: exports the weights to ONNX (browser, Claude plugin) and Core ML (iOS)
# in model/releases/<version>/, uploads them as the GitHub release model-<version>, and points
# model/current at it. Commit the model/current change so everyone builds against the new model.
# usage: model/release.sh <version> [weights.pt]   e.g. model/release.sh r4 model/runs/r4/weights/best.pt
#        (leave out the weights to upload a release that is already exported, e.g. r3)
set -e
ver=$1
weights=$2
# the weights path is relative to where this was run from
[ -z "$weights" ] || weights=$(cd "$(dirname "$weights")" && pwd)/$(basename "$weights")
cd "$(dirname "$0")"
dir=releases/$ver
PY=${PY:-../.venv/bin/python}
if [ -z "$ver" ]; then
  echo "usage: model/release.sh <version> [weights.pt]" >&2
  exit 1
fi
if [ -n "$weights" ]; then
  mkdir -p "$dir"
  cp "$weights" "$dir/ball.pt"
  "$PY" tools/export.py "$dir/ball.pt" "$dir"
  "$PY" tools/export_coreml.py "$dir/ball.pt" "$dir"
fi
for f in ball.onnx BallModel.mlpackage ball.pt; do
  [ -e "$dir/$f" ] || { echo "release.sh: $dir/$f is missing" >&2; exit 1; }
done
(cd "$dir" && rm -f BallModel.mlpackage.zip && zip -qr BallModel.mlpackage.zip BallModel.mlpackage)
gh release create "model-$ver" "$dir/ball.onnx" "$dir/BallModel.mlpackage.zip" "$dir/ball.pt" \
  --title "Ball model $ver" \
  --notes "YOLO11n juggling-ball detector, release $ver. ball.onnx: 640x384 input (browser demo, Claude plugin). BallModel.mlpackage.zip: 640x640 Core ML (iOS app). ball.pt: Ultralytics weights for fine-tuning. Fetch with model/fetch.sh."
rm "$dir/BallModel.mlpackage.zip"
ln -sfn "releases/$ver" current
echo "released model-$ver; model/current -> releases/$ver"
