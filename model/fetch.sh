#!/bin/sh
# Downloads a model release from this repo's GitHub releases into model/releases/<version>/.
# The iOS app, the Claude plugin and the browser demo all link to model/current, so after this
# there is one copy of each model on disk.
# usage: model/fetch.sh [version]   (default: the release model/current points at)
set -e
cd "$(dirname "$0")"
ver=${1:-$(basename "$(readlink current)")}
dir=releases/$ver
if [ -f "$dir/ball.onnx" ] && [ -d "$dir/BallModel.mlpackage" ]; then
  echo "model $ver: already in model/$dir"
  exit 0
fi
repo=${JUGGLE_REPO:-$(git remote get-url origin 2>/dev/null | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##')}
if [ -z "$repo" ]; then
  echo "fetch.sh: no GitHub remote to download from. Set JUGGLE_REPO=<owner>/<repo>." >&2
  exit 1
fi
mkdir -p "$dir"
for f in ball.onnx BallModel.mlpackage.zip ball.pt; do
  curl -fL --progress-bar -o "$dir/$f" "https://github.com/$repo/releases/download/model-$ver/$f"
done
(cd "$dir" && rm -rf BallModel.mlpackage && unzip -q BallModel.mlpackage.zip && rm BallModel.mlpackage.zip)
echo "model $ver -> model/$dir"
