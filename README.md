# juggle-break

A Claude Code plugin for the desktop app: juggle while Claude works.

- Send a prompt and a **Juggle break** pane opens with your camera and starts counting juggles.
- The header shows your **All time best**, **Last** and **Current** run.
- When Claude finishes, the camera turns off and the pane counts down
  "Returning to work in 5..." with the session's stats, then closes.
- The ⚙ cog opens settings: pick the camera, toggle **Overlay tracking data**, reset your score,
  and a **Sessions** tab with every juggling session.
- `/juggle` opens the pane by hand.

Scores and settings live in `~/.juggle-break/stats.json`.

## Setup

```bash
./setup.sh
```

This creates `.venv` with OpenCV and onnxruntime for the camera helper and builds
`Juggle Break Camera.app`, a small app the helper runs inside. Then load the plugin from
this folder, e.g. add its path to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of
`~/.claude/settings.json`, or run `claude --plugin-dir <this folder>`.

The first time the camera opens, macOS asks whether **Juggle Break Camera** may use the camera
(the pane says it is waiting). Your answer is remembered, and the app is listed under
System Settings > Privacy & Security > Camera. The helper can't ask as Claude Code: that app
declares no camera use, so macOS silently refuses anything it starts.

## How it works

- `hooks/register.tsx`: the plugin. `prompt.submit` starts a session and opens the pane,
  `turn.complete` ends it and runs the countdown. The pane draws each camera frame as an SVG.
- `helper/launch.sh` and `camera-app/`: open the helper inside Juggle Break Camera.app and pipe
  its output back. The app's launcher waits for the camera permission, then runs `juggle.py`.
- `helper/juggle.py`: reads the camera, runs the ball detector, counts throws, and streams
  JSON lines (frames ~10/s as small JPEGs, throws, run ends) to the plugin.
  `--list` prints the cameras; `--video FILE` counts a video file (for testing).
- `helper/counter.py`: the tracker and throw counter (one count per arc, at its apex; a run ends
  after 1.5 s without a throw).
- `model/ball.onnx`: the YOLO11n ball detector (round 3), 640×384 input.

## Tests

```bash
claude plugin test .
```
