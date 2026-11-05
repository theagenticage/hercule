#!/bin/sh
# Starts a virtual screen with a window manager and a D-Bus session, then runs
# the command it is given on that screen, and exits with the command's status.
# It is the entry point of the image built from `Dockerfile` in this folder.
#
# The screen is 1920 by 1080, a fixed size so that a test of the saved window
# bounds means the same thing on every run. The container ends when the
# command does, which stops Xvfb and openbox with it.
set -eu

export DISPLAY=:99

# D-Bus and the keyring look up the user they run as, and fail for a user ID
# with no passwd entry. The container runs as the host user, whose ID the image
# does not know (a CI runner is 1001, a laptop 1000 or 501), so the entry is
# added here.
if ! getent passwd "$(id -u)" >/dev/null; then
  echo "hercule:x:$(id -u):$(id -g):hercule:${HOME:-/tmp}:/bin/sh" >> /etc/passwd
fi

# Waits up to 10 seconds for a command to succeed, and fails with the log of
# the program it was waiting for.
wait_for() {
  description=$1; log=$2; shift 2
  for _ in $(seq 100); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 0.1
  done
  echo "entry.sh: $description did not start; its log:" >&2
  cat "$log" >&2
  exit 1
}

Xvfb "$DISPLAY" -screen 0 1920x1080x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
wait_for "Xvfb" /tmp/xvfb.log xprop -root

# The window manager starts inside the D-Bus session, so the app finds the
# session's bus address in its environment. A command that needs the window
# manager, such as one that maximizes a window, must not start before openbox
# has claimed the screen, so the script waits for it.
exec dbus-run-session -- sh -c '
  openbox >/tmp/openbox.log 2>&1 &
  for _ in $(seq 100); do
    xprop -root _NET_SUPPORTING_WM_CHECK | grep -q "window id" && exec "$@"
    sleep 0.1
  done
  echo "entry.sh: openbox did not start; its log:" >&2
  cat /tmp/openbox.log >&2
  exit 1
' entry "$@"
