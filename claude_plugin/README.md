# juggle-break

A Claude Code plugin for the desktop app: juggle while Claude works.

![The Juggle break pane: the camera mid-run with a count of 8 and the balls' trails, and the
end-of-break summary counting down to work](screenshot.png)

- Send a prompt and a **Juggle break** pane opens with your camera and counts your throws.
- The video shows **this run** big, your **last run** between runs, and the break's time, runs,
  best run and throws.
- When Claude finishes, the camera turns off and the pane counts down "Back to work in 5", with
  the break's **best run** (in orange), throws and your all-time **record**, then closes.
- The ⚙ button opens settings: pick the camera, **Show ball tracking**, **Clear record and
  history**, and a **History** tab listing every break.
- `/juggle` opens the pane by hand.

Scores and settings live in `~/.juggle-break/stats.json`. The helper's log is at
`~/.juggle-break/log.txt`.

## Install

You need:

- macOS 13 or later;
- Python 3.11+;
- the Xcode command line tools (`xcode-select --install`, for `clang` and `codesign`);
- `curl` and `unzip`.

The plugin uses the ball model from this repo's `model/` folder, so install it from a clone of the
whole repo.

1. Run the setup script:

   ```bash
   claude_plugin/setup.sh
   ```

   It does three things:
   - Runs `model/fetch.sh`, which downloads the current ball model release into `model/releases/`.
     `claude_plugin/model/ball.onnx` links to it.
   - Creates `claude_plugin/.venv` with OpenCV and onnxruntime.
   - Builds `Juggle Break Camera.app`, the small app the camera helper runs inside.

   It ends with `juggle-break: helper ready`. If `fetch.sh` says there's no GitHub remote to
   download from, set `JUGGLE_REPO=<owner>/<repo>` and run setup again.

2. Check the helper runs:

   ```bash
   claude_plugin/.venv/bin/python claude_plugin/helper/juggle.py --list
   ```

   This prints a JSON line listing the cameras. Use `--video <file>` to count a video instead.

3. Load the plugin. In `~/.claude/settings.json`, add the **absolute path** of this
   `claude_plugin` folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block:

   ```json
   { "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/absolute/path/to/juggle_tracker/claude_plugin" } }
   ```

   If `CLAUDE_CODE_PLUGIN_DIRS` already lists other folders, add this one alongside them. For a
   single session, `claude --plugin-dir /absolute/path/to/juggle_tracker/claude_plugin` works too.
   Restart the Claude desktop app, or start a new session, to pick it up.

4. Check that it loaded: `claude plugin validate claude_plugin` should end with
   `✔ Validation passed`. In the desktop app, `/juggle` should open the pane.

The first time the camera opens, macOS asks whether **Juggle Break Camera** may use the camera,
and the pane says it is waiting. Your answer is remembered, and the app is listed under System
Settings > Privacy & Security > Camera. The helper can't ask as Claude Code itself: Claude Code
declares no camera use, so macOS silently refuses camera access to anything it starts.

## How it works

- `hooks/register.tsx` is the plugin. `prompt.submit` starts a session and opens the pane, and
  `turn.complete` ends it and runs the countdown. The pane draws each camera frame as an SVG.
- `helper/launch.sh` and `camera-app/` open the helper inside Juggle Break Camera.app and pipe its
  output back. The app's launcher waits for the camera permission, then runs `juggle.py`.
- `helper/juggle.py` reads the camera, runs the ball detector and counts throws. It streams JSON
  lines back to the plugin: frames at about 10 per second as small JPEGs, throws, and run ends.
- `helper/counter.py` is the tracker and throw counter, ported from `model/web/counter.js`. It
  counts once per arc, at the apex, and ends a run after 1.5 s without a throw.
- `model/ball.onnx` links to `../../model/current/ball.onnx`, the YOLO11n ball detector with a
  640×384 input.

## Tests

```bash
claude plugin test claude_plugin
```
