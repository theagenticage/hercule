#!/bin/sh
# Installs Hercule from the `edge` prerelease, or updates an installed one:
#
#   curl -fsSL https://raw.githubusercontent.com/theagenticage/hercule/edge/install.sh | sh
#
# `edge` is the rolling prerelease of `main` that CI publishes (spec 15
# section 1). The command above reads this script from the `edge` tag, so the
# script and the files it downloads come from the same commit, except for up
# to five minutes after a publish, while raw.githubusercontent.com may still
# serve the previous script. Running it again is the update. For the user who
# runs it, it installs:
#
# - the binary, at ~/.local/bin/hercule;
# - on macOS, the desktop app, at /Applications/Hercule.app.
#
# A first install starts nothing. It prints the next step instead. On macOS
# with the default Hercule Home, that is first the app, which asks whether
# this Mac runs Hercule or connects to it elsewhere. Then, for every Home,
# `hercule service install` to run Hercule on this machine without the app (or
# on Linux, which has no app), or the join command from the Fleet's "Add
# machine" to make this machine a runner of a controller elsewhere. The app is
# named only for the default Home, because the app always uses that Home.
#
# An update is a run that finds the service unit installed
# (~/Library/LaunchAgents/sh.hercule.service.plist on macOS, or
# ${XDG_CONFIG_HOME:-~/.config}/systemd/user/hercule.service on Linux). It
# runs `hercule service install` with the new binary, which rewrites the unit
# and restarts it. The restart ends the turns in progress. An update never
# adds a unit where there is none, and it never touches the Hercule Home
# itself: the controller migrates its database at boot, after keeping a copy
# of it.
#
# Environment:
#
# - HERCULE_HOME: the Hercule Home, when it is not ~/.hercule. It must be an
#   absolute path, and is set for `sh`, not for `curl`:
#   `curl ... | HERCULE_HOME=/path sh`. A first install puts it in the
#   `hercule service install` command it prints. An update keeps the Home the
#   installed unit already names. It changes only the Home: the binary (and on
#   macOS the app) are still the user's one install, so a run with a scratch
#   Home replaces them too.
# - HERCULE_RELEASE_URL: where to download the release from, instead of the
#   `edge` release on GitHub. Any URL curl reads, file:// included.
# - HERCULE_APPLICATIONS_DIR: the folder the app is installed in, instead of
#   /Applications. It exists for the tests of this script, which must not
#   replace or quit the app the person running them uses. macOS only.
#
# Outside `main`, the script only sets variables and defines functions. `main`
# does the work and is called on the last line, so a download cut off halfway
# runs nothing.

set -eu
# On macOS, launchd runs the binary and the user opens the app, so neither may
# be writable by other users, whatever the caller's umask is. On Linux, only
# the binary.
umask 022

release_url=${HERCULE_RELEASE_URL:-https://github.com/theagenticage/hercule/releases/download/edge}
bin_dir="$HOME/.local/bin"
app="${HERCULE_APPLICATIONS_DIR:-/Applications}/Hercule.app"
# The file `hercule service install` keeps the unit in. Whether it exists is
# what tells an update from a first install.
plist_path="$HOME/Library/LaunchAgents/sh.hercule.service.plist"
# The systemd unit path. XDG_CONFIG_HOME is ignored if relative, per the XDG
# Base Directory spec (locateSystemdUnitDir in packages/service/src/systemd.ts).
case "${XDG_CONFIG_HOME:-}" in
  /*) config_home=$XDG_CONFIG_HOME ;;
  *) config_home=$HOME/.config ;;
esac
systemd_unit_path="$config_home/systemd/user/hercule.service"

fail() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

# Runs a command every half second until it fails. Returns 1 if it still
# succeeds after 30 seconds.
wait_until_fails() {
  tries=0
  while "$@"; do
    tries=$((tries + 1))
    [ "$tries" -le 60 ] || return 1
    sleep 0.5
  done
}

# Prints the pattern pgrep matches the desktop app's main process with: its
# executable, followed by its arguments or nothing. The characters a regular
# expression gives a meaning to, such as the dot in `.app`, are escaped.
build_app_process_pattern() {
  printf '^%s( |$)' "$(printf '%s' "$app/Contents/MacOS/Hercule" | sed 's/[][\.*^$+?(){}|]/\\&/g')"
}

# Checks whether this user has the desktop app open. Another user's copy of
# the app is not this script's to quit.
is_app_running() {
  pgrep -U "$(id -u)" -f "$app_process_pattern" > /dev/null
}

# Prints a word single-quoted, so a path with a space or a `$` in it pastes
# into a shell as one word. A single quote inside the word is written '\''.
quote_shell_word() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# Prints the Hercule Home the installed unit passes to Hercule, or nothing when
# there is no unit or it names none.
read_installed_hercule_home() {
  os=$(uname -s)
  case "$os" in
    Darwin)
      [ -f "$plist_path" ] || return 0
      # plutil prints its error to standard output, so its output counts only when
      # it succeeds.
      if home=$(plutil -extract EnvironmentVariables.HERCULE_HOME raw -o - "$plist_path" 2> /dev/null); then
        printf '%s\n' "$home"
      fi
      ;;
    Linux)
      [ -f "$systemd_unit_path" ] || return 0
      # Extract HERCULE_HOME from the systemd unit file. The line is:
      # Environment="HERCULE_HOME=/path/to/home"
      # The value is quoted and escaped: backslashes and quotes are escaped with
      # backslash, and % is escaped as %%. Decode exactly what renderSystemdUnit
      # (packages/service/src/unit.ts) produces.
      line=$(grep -E '^Environment="HERCULE_HOME=' "$systemd_unit_path" 2> /dev/null | head -1)
      if [ -n "$line" ]; then
        # Extract the quoted value after Environment= and remove outer quotes
        escaped=$(printf '%s\n' "$line" | sed -E 's/^Environment="(.*)"/\1/')
        # Unescape: \\ -> \, \" -> ", then %% -> %
        # Use sed to handle the escapes: first backslash escapes, then percent
        unescaped=$(printf '%s\n' "$escaped" | sed -e 's/\\\\/\x00/g' -e 's/\\"/"/g' -e 's/\x00/\\/g' -e 's/%%/%/g')
        if [ -n "$unescaped" ]; then
          # The value is HERCULE_HOME=<path>; strip the prefix
          home=$(printf '%s\n' "$unescaped" | sed 's/^HERCULE_HOME=//')
          printf '%s\n' "$home"
        fi
      fi
      ;;
  esac
}

main() {
  os=$(uname -s)
  arch=$(uname -m)

  # Detect platform and set binary name
  case "$os" in
    Darwin)
      # `uname -m` prints x86_64 in a shell running under Rosetta.
      # `hw.optional.arm64` is 1 on Apple silicon either way.
      if [ "$(sysctl -n hw.optional.arm64 2> /dev/null)" != 1 ]; then
        fail "the edge build runs on macOS on Apple silicon and on Linux, and this machine is Darwin $arch. Intel Macs come with the stable releases."
      fi
      binary_name="hercule-darwin-arm64"
      has_app=true
      unit_path=$plist_path
      ;;
    Linux)
      case "$arch" in
        x86_64) binary_name="hercule-linux-x64" ;;
        aarch64) binary_name="hercule-linux-arm64" ;;
        *)
          fail "the edge build runs on macOS on Apple silicon and on Linux on x86_64 and aarch64, and this machine is Linux $arch."
          ;;
      esac
      has_app=false
      unit_path=$systemd_unit_path
      ;;
    *)
      fail "the edge build runs on macOS on Apple silicon and on Linux on x86_64 and aarch64, and this machine is $os $arch."
      ;;
  esac

  if [ "$has_app" = true ]; then
    app_process_pattern=$(build_app_process_pattern)
  fi

  # An update keeps the Home the installed unit already uses, so a run without
  # HERCULE_HOME never moves Hercule to an empty ~/.hercule.
  installed_home=$(read_installed_hercule_home)
  hercule_home=${HERCULE_HOME:-${installed_home:-$HOME/.hercule}}
  case $hercule_home in
    /*) ;;
    *) fail "HERCULE_HOME is $hercule_home, which is not an absolute path. The service starts Hercule in /, where a relative path names another folder." ;;
  esac
  if [ -n "$installed_home" ] && [ "$hercule_home" != "$installed_home" ]; then
    fail "the installed service uses the Hercule Home $installed_home, and this run asks for $hercule_home. To move Hercule to another Home, run \`hercule service uninstall\`, then run this again."
  fi

  # Checked before anything is replaced, so a user who cannot install apps
  # keeps the install they have. Only on macOS.
  if [ "$has_app" = true ]; then
    [ -w "${app%/*}" ] || fail "$(id -un) cannot write to ${app%/*}. Run this as a user who can install apps."
  fi

  download_dir=$(mktemp -d)
  trap 'rm -rf "$download_dir"' EXIT

  # The asset names and the format of SHA256SUMS come from the `edge-build`
  # job in .github/workflows/ci.yml; change them together.
  assets_to_download="$binary_name SHA256SUMS"
  if [ "$has_app" = true ]; then
    assets_to_download="$assets_to_download Hercule-darwin-arm64.zip"
  fi

  for asset in $assets_to_download; do
    printf 'Downloading %s\n' "$asset"
    curl -fL --proto-redir =https --progress-bar --retry 3 -o "$download_dir/$asset" "$release_url/$asset" ||
      fail "could not download $asset from $release_url. While CI replaces the edge release, it is missing for a minute; try again shortly."
  done
  # `shasum -c` checks only the files SHA256SUMS lists, so a file the list
  # leaves out would go unchecked.
  grep -q "  $binary_name\$" "$download_dir/SHA256SUMS" ||
    fail "SHA256SUMS does not list $binary_name, so nothing was installed."
  if [ "$has_app" = true ]; then
    grep -q "  Hercule-darwin-arm64.zip\$" "$download_dir/SHA256SUMS" ||
      fail "SHA256SUMS does not list Hercule-darwin-arm64.zip, so nothing was installed."
  fi
  (cd "$download_dir" && sha256sum -c --quiet --ignore-missing SHA256SUMS 2> /dev/null || shasum -a 256 -c --quiet --ignore-missing SHA256SUMS) ||
    fail "a downloaded file does not match SHA256SUMS, so nothing was installed. While CI replaces the edge release, its files can disagree for a minute; try again shortly."

  # The zip is unpacked before anything is replaced, so a broken one leaves the
  # installed app alone. macOS only.
  if [ "$has_app" = true ]; then
    ditto -x -k "$download_dir/Hercule-darwin-arm64.zip" "$download_dir/app"
  fi

  is_update=false
  [ -f "$unit_path" ] && is_update=true

  # SIGTERM makes the app quit the way choosing Quit does. macOS only.
  app_was_running=false
  if [ "$has_app" = true ] && is_app_running; then
    app_was_running=true
    printf 'Quitting Hercule.app\n'
    # The app may quit on its own between the check and the signal.
    pkill -TERM -U "$(id -u)" -f "$app_process_pattern" || true
    wait_until_fails is_app_running ||
      fail "Hercule.app did not quit within 30 seconds. Quit it and run this again; nothing was replaced."
  fi
  # The old app is moved aside rather than deleted, so it can be put back if
  # the new one cannot be moved in. macOS only.
  if [ "$has_app" = true ]; then
    if [ -e "$app" ]; then
      mv "$app" "$download_dir/old.app"
    fi
    if ! mv "$download_dir/app/Hercule.app" "$app"; then
      if [ -e "$download_dir/old.app" ]; then
        mv "$download_dir/old.app" "$app"
      fi
      fail "could not move the new Hercule.app into ${app%/*}. The installed app is unchanged."
    fi
    printf 'Installed %s\n' "$app"
  fi

  # The binary is replaced last, just before the service restarts, so the
  # controller never runs a binary newer than the app beside it (on macOS).
  # The new binary is renamed over the old one rather than written into it.
  # The rename is atomic, so nothing ever runs half a file. And macOS caches a
  # signed executable's signature per file, so it refuses to run one that was
  # rewritten in place.
  mkdir -p "$bin_dir"
  cp "$download_dir/$binary_name" "$bin_dir/.hercule.new"
  chmod 755 "$bin_dir/.hercule.new"
  mv -f "$bin_dir/.hercule.new" "$bin_dir/hercule"
  printf 'Installed %s\n' "$bin_dir/hercule"

  # How the user runs the binary from their shell, for the commands this
  # script prints.
  bin_dir_on_path=false
  case ":$PATH:" in
    *":$bin_dir:"*) bin_dir_on_path=true ;;
  esac
  hercule_command=hercule
  $bin_dir_on_path || hercule_command=$(quote_shell_word "$bin_dir/hercule")
  if [ "$hercule_home" != "$HOME/.hercule" ]; then
    hercule_command="HERCULE_HOME=$(quote_shell_word "$hercule_home") $hercule_command"
  fi

  # The new binary rewrites the unit, so it runs the new binary, and restarts
  # it. It decides again whether this Mac runs the controller or a runner, from
  # what the Home holds, and waits until Hercule has started and stays up. When
  # it fails, its own output explains what went wrong.
  service_updated=true
  if $is_update; then
    printf '\nUpdating the service\n'
    HERCULE_HOME=$hercule_home "$bin_dir/hercule" service install || service_updated=false
  fi

  # Reopened before a failed update is reported, so the app this script quit
  # is back either way. macOS only.
  if [ "$has_app" = true ] && $app_was_running; then
    open "$app"
  fi

  if ! $service_updated; then
    if [ "$has_app" = true ]; then
      fail "the binary and the app are updated, but the service was not. The lines above explain why. Fix that and run \`$hercule_command service install\`."
    else
      fail "the binary is updated, but the service was not. The lines above explain why. Fix that and run \`$hercule_command service install\`."
    fi
  fi

  printf '\nHercule %s is installed.\n' "$("$bin_dir/hercule" --version)"

  if ! $bin_dir_on_path; then
    # shellcheck disable=SC2016 # the line keeps $PATH for the profile to expand
    printf '\n%s is not on your PATH. To put it there, add this line to your shell profile:\n\n  export PATH="%s:$PATH"\n' "$bin_dir" "$bin_dir"
  fi

  if ! $is_update; then
    if [ "$has_app" = true ] && [ "$hercule_home" = "$HOME/.hercule" ]; then
      printf '\nNothing is running yet. To set up Hercule, open Hercule in your Applications folder.\n'
      printf '\nTo run Hercule on this Mac without the app, start it as a service, then open the setup page in your browser; the second command prints its address:\n\n  %s service install\n  %s setup-url\n' "$hercule_command" "$hercule_command"
    else
      machine_word="machine"
      [ "$os" = Darwin ] && machine_word="Mac"
      printf '\nNothing is running yet. To run Hercule on this %s, start it as a service, then open the setup page in your browser; the second command prints its address:\n\n  %s service install\n  %s setup-url\n' "$machine_word" "$hercule_command" "$hercule_command"
    fi
    machine_word="machine"
    [ "$os" = Darwin ] && machine_word="Mac"
    printf '\nTo make this %s a runner of a controller on another machine instead, run the join command from the Fleet'\''s "Add machine" in that controller'\''s web app' "$machine_word"
    if [ "$hercule_command" != hercule ]; then
      printf ', with %s in place of hercule' "$hercule_command"
    fi
    printf '. It joins this %s and starts the runner as a service.\n' "$machine_word"
  fi
}

main "$@"
