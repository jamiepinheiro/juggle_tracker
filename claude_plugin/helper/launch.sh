#!/bin/sh
# Runs the helper inside "Juggle Break Camera.app" so macOS asks for camera access for that app
# (processes Claude Code starts directly cannot be granted the camera). Streams its stdout here.
root=$(cd "$(dirname "$0")/.." && pwd)
app="$root/Juggle Break Camera.app"
if [ ! -x "$app/Contents/MacOS/launcher" ]; then
  echo '{"type":"error","message":"The camera app is not built. Run setup.sh in the plugin folder."}'
  exit 1
fi
fifo=$(mktemp -u "${TMPDIR:-/tmp}/juggle-break.XXXXXX")
mkfifo "$fifo" || exit 1
open -W -n -g -a "$app" --stdout "$fifo" --stderr "$root/.helper-stderr.log" --args --watch-pid $$ "$@" &
# The pipe is opened at both ends within moments; remove its name once that has happened.
(sleep 10; rm -f "$fifo") &
# Become the reader. The helper watches this pid (--watch-pid $$) and exits when the plugin stops it.
exec cat "$fifo"
