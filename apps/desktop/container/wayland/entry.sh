#!/bin/sh
# Starts sway, headless, on a D-Bus session, then runs the command it is given
# with the environment of a Wayland session, and exits with the command's
# status. It is the entry point of the image built from `Dockerfile` in this
# folder. The output is 1920 by 1080 and sway tiles a window onto all of it, as
# a tiling compositor does. Sway draws no frame around a window, as Hyprland
# does not.
#
# Environment variables, all optional:
#
# - `XDG_CURRENT_DESKTOP`: what the session says its desktop is. Hyprland by
#   default.
# - `SESSION_TYPE`: the value of `XDG_SESSION_TYPE`, `wayland` by default.
#   `unset` leaves the variable out, as in a session started by hand.
# - `XWAYLAND`: `1` sets `DISPLAY` to XWayland's. Without it `DISPLAY` is
#   unset, so only a native Wayland client can run.
# - `TILING_BORDER`: `1` makes sway draw a title bar on each window, as a
#   compositor with server-side decorations does.
set -eu

export XDG_RUNTIME_DIR=/tmp/xdg
rm -rf "$XDG_RUNTIME_DIR"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

border=none
if [ "${TILING_BORDER:-}" = 1 ]; then border=normal; fi
cat > /tmp/sway.conf <<CONF
xwayland enable
output HEADLESS-1 mode 1920x1080 position 0 0
default_border $border
default_floating_border $border
font pango:DejaVu Sans 10
CONF

# Sway runs inside the D-Bus session, so the app finds the session's bus
# address in its environment.
exec dbus-run-session -- sh -c '
  export WLR_BACKENDS=headless WLR_RENDERER=pixman WLR_LIBINPUT_NO_DEVICES=1 WLR_HEADLESS_OUTPUTS=1
  sway -c /tmp/sway.conf >/tmp/sway.log 2>&1 &
  sway_pid=$!
  for _ in $(seq 100); do
    ls "$XDG_RUNTIME_DIR" | grep -q "^wayland-" && break
    sleep 0.1
  done
  export WAYLAND_DISPLAY=$(ls "$XDG_RUNTIME_DIR" | grep "^wayland-" | grep -v lock | head -1)
  export SWAYSOCK=$(ls "$XDG_RUNTIME_DIR"/sway-ipc.*.sock | head -1)
  export XDG_CURRENT_DESKTOP=${XDG_CURRENT_DESKTOP:-Hyprland}
  unset DISPLAY
  if [ "${SESSION_TYPE:-wayland}" = unset ]; then
    unset XDG_SESSION_TYPE
  else
    export XDG_SESSION_TYPE=${SESSION_TYPE:-wayland}
  fi
  if [ "${XWAYLAND:-}" = 1 ]; then
    # Sway makes XWayland'"'"'s socket at start and starts the server on the
    # first X client.
    for _ in $(seq 50); do
      socket=$(ls /tmp/.X11-unix 2>/dev/null | head -1)
      [ -n "$socket" ] && export DISPLAY=":${socket#X}" && break
      sleep 0.1
    done
  fi
  status=0
  "$@" || status=$?
  kill "$sway_pid" 2>/dev/null || true
  exit "$status"
' entry "$@"
