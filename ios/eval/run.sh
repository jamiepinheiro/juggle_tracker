#!/bin/sh
# Score the iOS pipeline on labelled videos. usage: ios/eval/run.sh path/to/IMG_xxxx.MOV [...]
# Uses the model the app ships (Model/BallModel.mlpackage, a link to model/current).
set -e
videos=""
for v in "$@"; do videos="$videos $(cd "$(dirname "$v")" && pwd)/$(basename "$v")"; done
cd "$(dirname "$0")"
APP=../JuggleTracker/JuggleTracker
BUILD=.build && mkdir -p $BUILD
xcrun coremlcompiler compile $APP/Model/BallModel.mlpackage $BUILD >/dev/null
swiftc -O -o $BUILD/eval main.swift $APP/Tracking/BallModelDetector.swift \
  $APP/Tracking/TrackingEngine.swift $APP/Tracking/JuggleCounter.swift $APP/Tracking/VideoSource.swift 2>&1 | grep -v warning || true
$BUILD/eval $BUILD/BallModel.mlmodelc $videos
