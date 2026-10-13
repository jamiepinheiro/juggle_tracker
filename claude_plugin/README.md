# juggle-break

```
/plugin marketplace add jamiepinheiro/juggle_tracker
/plugin install juggle-break@juggle-tracker
```

Run these in `claude` in a terminal; see [Install](#install).

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

In a terminal, run `claude`, then:

```
/plugin marketplace add jamiepinheiro/juggle_tracker
/plugin install juggle-break@juggle-tracker
```

The first line adds this repo as a plugin marketplace; the second installs the plugin from it.
Pick the user scope. The plugin then loads in every session, the desktop app's included (restart
the app if it is open). `/plugin` is a terminal command; the desktop app's Code tab doesn't offer
it.

The first break sets the camera helper up by itself, in a minute or so: the pane says
"Setting up the camera" while it downloads the ball model, creates a Python environment with
OpenCV and onnxruntime, and builds `Juggle Break Camera.app`. It needs:

- macOS 13 or later;
- Python 3.11 or later, or [uv](https://docs.astral.sh/uv/), which fetches its own;
- the Xcode command line tools (`xcode-select --install`), for `clang` and `codesign`.

If one is missing, the pane says which. `claude_plugin/setup.sh` does the same setup by hand.

### From a clone

To work on the plugin, load it from your clone instead: run `claude_plugin/setup.sh` (in a clone
it uses the repo's `model/` folder), then add the absolute path of `claude_plugin` to
`CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`, or run
`claude --plugin-dir <path>` for one session. Edits reload the plugin as you save.

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
