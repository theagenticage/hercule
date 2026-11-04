#!/bin/bash
# Checks the desktop app's Arch Linux package on a bare Arch install, the way a
# user installs it. It runs as root inside the official `archlinux` image, and
# is run by `desktop-linux` in .github/workflows/ci.yml and by hand:
#
#   docker run --rm --security-opt seccomp=unconfined \
#     -v "$PWD/apps/desktop/container":/check:ro -v /path/to/packages:/packages:ro \
#     archlinux:latest bash /check/arch-install-check.sh \
#       /packages/first.pkg.tar.zst /packages/second.pkg.tar.zst /tmp/debug
#
# It fails, with the reason, unless all of this holds:
#
# - pacman installs the first package, with nothing but its `depends`;
# - the files are where they should be: the app, the `.desktop` entry, the
#   icon, and the command in /usr/bin;
# - ldd finds every library of every program and library in /opt/Hercule,
#   before any other package is installed;
# - the app starts as a normal user, on a virtual screen, without any switch
#   that turns the sandbox off, shows a window, stays up, and quits on SIGTERM;
# - the second package, which has a higher version, installs over the first,
#   and the app starts again.
#
# `--security-opt seccomp=unconfined` lets Chromium create user namespaces,
# which Docker's default profile blocks. Without it the sandbox cannot start,
# the same as on a host that forbids user namespaces.
set -Eeuo pipefail
# A command that fails without a message of its own would stop the script
# silently. This names the line and the command.
trap 'echo "::error::arch-install-check.sh stopped at line $LINENO, running: $BASH_COMMAND"' ERR

first=$1
second=$2
debug_dir=$3
mkdir -p "$debug_dir"

fail() {
  echo "::error::$*"
  import -window root "$debug_dir/screen.png" 2> /dev/null || true
  xwininfo -root -tree > "$debug_dir/windows.txt" 2>&1 || true
  pgrep -af '^/opt/Hercule/' | cut -c1-200 || true
  exit 1
}

echo "--- Updating the package database and the base system"
pacman -Syu --noconfirm > "$debug_dir/pacman-update.log" 2>&1 || { cat "$debug_dir/pacman-update.log"; fail "pacman -Syu failed."; }

echo "--- Installing $first"
pacman -U --noconfirm "$first" || fail "pacman could not install $first."
echo "Installed: $(pacman -Q hercule-desktop)"

echo "--- Files of the package"
pacman -Ql hercule-desktop | grep -vE ' /opt/Hercule/.+' || true
for path in \
  /opt/Hercule/hercule-desktop \
  /opt/Hercule/chrome-sandbox \
  /usr/share/applications/hercule-desktop.desktop \
  /usr/share/icons/hicolor/512x512/apps/hercule-desktop.png; do
  [ -f "$path" ] || fail "The package has no $path."
done
[ "$(readlink -f /usr/bin/hercule-desktop)" = /opt/Hercule/hercule-desktop ] ||
  fail "/usr/bin/hercule-desktop does not lead to /opt/Hercule/hercule-desktop."
echo "--- /usr/share/applications/hercule-desktop.desktop"
cat /usr/share/applications/hercule-desktop.desktop
grep -q '^Exec=.*/opt/Hercule/hercule-desktop' /usr/share/applications/hercule-desktop.desktop ||
  fail "The .desktop entry does not start /opt/Hercule/hercule-desktop."
echo "--- chrome-sandbox mode and owner: $(stat -c '%a %U' /opt/Hercule/chrome-sandbox)"

# Run before any other package is installed, so a library that only the test
# tools bring in cannot hide a missing dependency. Libraries that Electron
# opens at run time are not listed by ldd; starting the app covers those.
echo "--- Libraries every program and library in /opt/Hercule needs"
# `grep` exits 1 when a file has no missing library, which is the normal case,
# so each pipeline ends in `|| true`. Without it, `set -e` stops the script
# whenever the last file `find` lists is a program with every library found.
missing=$(
  find /opt/Hercule -type f | while read -r file; do
    [ "$(head -c4 "$file" | od -An -c | tr -d ' ')" = '177ELF' ] || continue
    ldd "$file" 2>&1 | grep 'not found' | sed "s#^#$file: #" || true
  done
)
if [ -n "$missing" ]; then
  echo "$missing"
  fail "ldd finds libraries that are not installed. Add the packages that hold them to the pacman depends in apps/desktop/electron-builder.yml."
fi
echo "ldd finds every library."

echo "--- Installing the tools of this check (after the ldd check)"
pacman -S --noconfirm --needed xorg-server-xvfb xorg-xwininfo xorg-xprop imagemagick desktop-file-utils > "$debug_dir/pacman-tools.log" 2>&1 ||
  { cat "$debug_dir/pacman-tools.log"; fail "Could not install the tools of this check."; }
desktop-file-validate /usr/share/applications/hercule-desktop.desktop || fail "The .desktop entry is not valid."

useradd --create-home tester
mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix
export DISPLAY=:99
as_tester() { setpriv --reuid=tester --regid=tester --init-groups "$@"; }
as_tester Xvfb "$DISPLAY" -screen 0 1920x1080x24 -nolisten tcp > "$debug_dir/xvfb.log" 2>&1 &
for _ in $(seq 100); do
  xprop -root > /dev/null 2>&1 && break
  sleep 0.1
done
xprop -root > /dev/null || { cat "$debug_dir/xvfb.log"; fail "Xvfb did not start."; }

# Same check as the Ubuntu one in ci.yml: a window of the app that is mapped
# and viewable and at least 200 by 200 pixels. There is no window manager.
has_viewable_window() {
  for id in $(xwininfo -root -tree | awk '/\("hercule-desktop" / { print $1 }'); do
    info=$(xwininfo -id "$id" 2> /dev/null) || continue
    width=$(echo "$info" | awk '/^ *Width:/ { print $2 }')
    height=$(echo "$info" | awk '/^ *Height:/ { print $2 }')
    if echo "$info" | grep -q 'Map State: IsViewable' && [ "${width:-0}" -ge 200 ] && [ "${height:-0}" -ge 200 ]; then
      return 0
    fi
  done
  return 1
}

start_and_check() {
  label=$1
  log=$debug_dir/app-$label.log
  home=$(mktemp -d)
  chown tester "$home"
  # `setpriv` and `env` replace themselves with the app, so $! is the app's own
  # pid. The app gets no switch that turns the sandbox off.
  as_tester env -u ELECTRON_DISABLE_SANDBOX HOME="$home" XDG_CONFIG_HOME="$home/.config" \
    XDG_CACHE_HOME="$home/.cache" XDG_DATA_HOME="$home/.local/share" \
    /opt/Hercule/hercule-desktop > "$log" 2>&1 &
  app_pid=$!

  window_found=false
  for _ in $(seq 60); do
    kill -0 "$app_pid" 2> /dev/null || { cat "$log"; fail "The app ($label) exited before it showed a window. Its log is above."; }
    if has_viewable_window; then
      window_found=true
      break
    fi
    sleep 1
  done
  $window_found || { cat "$log"; fail "The app ($label) showed no window within 60 seconds."; }

  sleep 10
  kill -0 "$app_pid" 2> /dev/null || { cat "$log"; fail "The app ($label) showed a window and then exited."; }
  has_viewable_window || fail "The app ($label) is running, but its window is gone."

  if tr '\0' '\n' < "/proc/$app_pid/environ" | grep -q '^ELECTRON_DISABLE_SANDBOX='; then
    fail "The app ($label) runs with ELECTRON_DISABLE_SANDBOX set."
  fi
  pgrep -af '^/opt/Hercule/hercule-desktop' | cut -c1-160
  if pgrep -f '^/opt/Hercule/hercule-desktop .*--no-sandbox' > /dev/null; then
    fail "A process of the app ($label) runs with --no-sandbox."
  fi

  # Whether the sandbox is on. Chromium aborts at start when it finds no
  # sandbox it can use, and the app refuses --no-sandbox, so an app that
  # stays up has one. The renderer's seccomp filter confirms that it is
  # applied to the process that runs web content. Which kind it is follows
  # from the mode of chrome-sandbox: mode 755 means the unprivileged user
  # namespace sandbox, and 4755 the setuid helper. /proc/<pid>/ns of a
  # sandboxed process is not readable, even by root.
  renderer_pid=$(pgrep -f '^/opt/Hercule/hercule-desktop .*--type=renderer' | head -1 || true)
  [ -n "$renderer_pid" ] || fail "The app ($label) has no renderer process."
  grep -E '^(NoNewPrivs|Seccomp):' "/proc/$renderer_pid/status" | tr '\n' ' '
  echo
  [ "$(awk '/^Seccomp:/ { print $2 }' "/proc/$renderer_pid/status")" = 2 ] ||
    fail "The renderer of the app ($label) has no seccomp filter, so it is not sandboxed."
  case "$(stat -c %a /opt/Hercule/chrome-sandbox)" in
    4755) echo "The sandbox is the setuid chrome-sandbox helper." ;;
    *) echo "The sandbox is the unprivileged user namespace sandbox: chrome-sandbox is not setuid." ;;
  esac
  echo "The app ($label) shows a window, has been up for 10 seconds, and its renderer is sandboxed."

  kill -TERM "$app_pid"
  for _ in $(seq 30); do
    kill -0 "$app_pid" 2> /dev/null || break
    sleep 1
  done
  if kill -0 "$app_pid" 2> /dev/null; then
    kill -KILL "$app_pid"
    fail "The app ($label) did not quit within 30 seconds of SIGTERM."
  fi
  rm -rf "$home"
}

start_and_check first

first_version=$(pacman -Q hercule-desktop | awk '{ print $2 }')
echo "--- Installing $second over $first_version"
pacman -U --noconfirm "$second" || fail "pacman could not install $second."
second_version=$(pacman -Q hercule-desktop | awk '{ print $2 }')
[ "$(vercmp "$second_version" "$first_version")" = 1 ] ||
  fail "After the upgrade the version is $second_version, which is not higher than $first_version."
echo "Upgraded: $first_version -> $second_version"
start_and_check upgraded
