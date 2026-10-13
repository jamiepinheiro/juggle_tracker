# ios

**Juggle Tracker** is a native SwiftUI app for iPhone and iPad (iOS 17+). It counts juggling
throws on-device with Core ML, using the ball model from `model/`.

```
JuggleTracker/   the Xcode project
eval/            runs the app's counting pipeline over videos and scores it against hand labels
AppStore/        App Store listing, review notes, screenshot editor and upload script
```

## Build

```bash
model/fetch.sh     # from the repo root, once: downloads the model the app bundles
open ios/JuggleTracker/JuggleTracker.xcodeproj
```

`JuggleTracker/Model/BallModel.mlpackage` is a link to `model/current/BallModel.mlpackage`, so
the app always builds with the current model release. The build fails with a missing
`BallModel.mlpackage` until `model/fetch.sh` has run.

Tests:
`xcodebuild -scheme JuggleTracker -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test`
(run in `ios/JuggleTracker`).

## How it works

- **Finding balls**: `Tracking/BallModelDetector.swift` runs the model on the Neural Engine. It
  letterboxes each frame to the model's square input, as in training, then decodes the raw output
  and merges overlapping boxes.
- **Counting**: `Tracking/JuggleCounter.swift` is a line-for-line port of `model/web/counter.js`.
  The app's run rules live in `Tracking/TrackingEngine.swift`:
  - A run ends after 1 s without a throw. The web demo uses 1.5 s, which merged quick restarts.
  - A single throw isn't saved as a run.
- **Sessions**: Start session, juggle, End session. The app saves:
  - runs, best run and average run;
  - total throws and throw rate;
  - session time and time spent juggling.

  The paperclip counts a recorded video instead of the camera. Settings exports everything as
  JSON.

Debug builds take `-debug-video <file>`, which counts that video on launch. A path relative to the
app's Documents folder works on a device. Use this to check counting on the Simulator, which has
no camera.

## Evaluating a model

```bash
ios/eval/run.sh data_labelling/data/videos/IMG_0736.MOV data_labelling/data/videos/IMG_0738.MOV
```

This runs the app's exact detector, engine and counter over each video. It reports per-attempt
counts and an error figure: per-attempt miscounts plus throws outside any attempt. The labels come
from `<video>.labels.json` next to the video if there is one. Otherwise they come from
`data_labelling/data/<video>/throws.labels.json`.

## App Store

- `AppStore/listing.json` holds the store listing.
- `AppStore/asc.py status|apply` reads the listing from App Store Connect, or pushes it.
  - It needs an App Store Connect API key at `~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8`.
  - Install its dependencies with `pip install pyjwt cryptography requests`.
- `AppStore/review/` has the App Review notes and the demo video.
- `AppStore/screenshots-editor/` is the Next.js editor that made the store screenshots:
  `bun install && bun dev`.
