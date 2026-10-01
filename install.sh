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
# - the desktop app, at /Applications/Hercule.app;
# - a launchd LaunchAgent that keeps `hercule serve` running.
#
# It restarts the controller, which ends the turns in progress. Inside the
# Hercule Home it only creates the `logs` folder: the controller migrates its
# database itself at boot, after keeping a copy of it.
#
# Environment:
#
# - HERCULE_HOME: the Hercule Home, when it is not ~/.hercule. It must be an
#   absolute path, and is set for `sh`, not for `curl`:
#   `curl ... | HERCULE_HOME=/path sh`. The LaunchAgent passes it on to
#   `hercule serve`, and an update keeps the Home the controller already
#   uses. It changes only the Home: the binary, the app and the LaunchAgent
#   are still the user's one install, so a run with a scratch Home replaces
#   them too.
# - HERCULE_RELEASE_URL: where to download the release from, instead of the
#   `edge` release on GitHub. Any URL curl reads, file:// included.
#
# Once `hercule service install` exists (#100), this script runs it instead of
# writing the LaunchAgent itself.
#
# Outside `main`, the script only sets variables and defines functions. `main`
# does the work and is called on the last line, so a download cut off halfway
# runs nothing.

set -eu
# launchd runs the binary and reads the plist, so neither may be writable by
# other users, whatever the caller's umask is.
umask 022

release_url=${HERCULE_RELEASE_URL:-https://github.com/theagenticage/hercule/releases/download/edge}
bin_dir="$HOME/.local/bin"
app=/Applications/Hercule.app
app_process_pattern='^/Applications/Hercule\.app/Contents/MacOS/Hercule( |$)'
# `hercule service install` (#100) writes its unit under this same label, so
# it replaces this LaunchAgent rather than adding a second one.
service_label=sh.hercule.service
plist_path="$HOME/Library/LaunchAgents/$service_label.plist"
launchd_domain="gui/$(id -u)"

fail() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

# Escapes the characters XML gives a meaning to, so a path can go in the plist.
escape_xml() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
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

# Checks whether launchd holds the controller's job.
is_service_loaded() {
  launchctl print "$launchd_domain/$service_label" > /dev/null 2>&1
}

# Prints the pid of the running controller, or nothing when it is not running.
read_controller_pid() {
  launchctl print "$launchd_domain/$service_label" 2> /dev/null | awk '$1 == "pid" && $2 == "=" { print $3; exit }'
}

# Checks whether this user has the desktop app open. Another user's copy of
# the app is not this script's to quit.
is_app_running() {
  pgrep -U "$(id -u)" -f "$app_process_pattern" > /dev/null
}

# Prints the Hercule Home the installed LaunchAgent passes to the controller,
# or nothing when there is no LaunchAgent or it names none.
read_installed_hercule_home() {
  [ -f "$plist_path" ] || return 0
  # plutil prints its error to standard output, so its output counts only when
  # it succeeds.
  if home=$(plutil -extract EnvironmentVariables.HERCULE_HOME raw -o - "$plist_path" 2> /dev/null); then
    printf '%s\n' "$home"
  fi
}

# Prints the PATH the controller runs with: ~/.local/bin, then the folders on
# the caller's PATH. launchd starts a job with only the system folders on its
# PATH, so the caller's is passed on instead, and the controller and its local
# runner find the same harnesses (claude, codex, pi), git and gh as the user
# does. Relative entries are dropped: the runner starts programs inside
# workspace checkouts, where `.` on the PATH would let a repository supply its
# own `git`.
build_service_path() {
  service_path=$bin_dir
  set -f
  old_ifs=$IFS
  IFS=:
  for dir in $PATH; do
    case $dir in
      /*)
        if [ -d "$dir" ] && [ "$dir" != "$bin_dir" ]; then
          service_path="$service_path:$dir"
        fi
        ;;
    esac
  done
  IFS=$old_ifs
  set +f
  printf '%s' "$service_path"
}

main() {
  # `uname -m` prints x86_64 in a shell running under Rosetta.
  # `hw.optional.arm64` is 1 on Apple silicon either way.
  if [ "$(uname -s)" != Darwin ] || [ "$(sysctl -n hw.optional.arm64 2> /dev/null)" != 1 ]; then
    fail "the edge build runs on macOS on Apple silicon only, and this machine is $(uname -s) $(uname -m). Linux and Intel Macs come with the stable releases."
  fi

  if ! launchctl print "$launchd_domain" > /dev/null 2>&1; then
    fail "$(id -un) is not logged in to this Mac's desktop, so launchd has nowhere to run the controller. Run this in Terminal on the Mac itself."
  fi

  # An update keeps the Home the controller already uses, so a run without
  # HERCULE_HOME never moves a controller to an empty ~/.hercule.
  installed_home=$(read_installed_hercule_home)
  hercule_home=${HERCULE_HOME:-${installed_home:-$HOME/.hercule}}
  case $hercule_home in
    /*) ;;
    *) fail "HERCULE_HOME is $hercule_home, which is not an absolute path. launchd starts the controller in /, where a relative path names another folder." ;;
  esac
  if [ -n "$installed_home" ] && [ "$hercule_home" != "$installed_home" ]; then
    fail "the controller uses the Hercule Home $installed_home, and this run asks for $hercule_home. To move the controller to another Home, stop it with \`launchctl bootout $launchd_domain/$service_label\`, delete $plist_path, and run this again."
  fi
  controller_log="$hercule_home/logs/controller.log"

  # Checked before anything is replaced, so a user who cannot install apps
  # keeps the install they have.
  [ -w "${app%/*}" ] || fail "$(id -un) cannot write to ${app%/*}. Run this as a user who can install apps."

  download_dir=$(mktemp -d)
  trap 'rm -rf "$download_dir"' EXIT

  # The asset names and the format of SHA256SUMS come from the `edge-build`
  # job in .github/workflows/ci.yml; change them together.
  for asset in hercule-darwin-arm64 Hercule-darwin-arm64.zip SHA256SUMS; do
    printf 'Downloading %s\n' "$asset"
    curl -fL --proto-redir =https --progress-bar --retry 3 -o "$download_dir/$asset" "$release_url/$asset" ||
      fail "could not download $asset from $release_url. While CI replaces the edge release, it is missing for a minute; try again shortly."
  done
  # `shasum -c` checks only the files SHA256SUMS lists, so a file the list
  # leaves out would go unchecked.
  for asset in hercule-darwin-arm64 Hercule-darwin-arm64.zip; do
    grep -q "  $asset\$" "$download_dir/SHA256SUMS" ||
      fail "SHA256SUMS does not list $asset, so nothing was installed."
  done
  (cd "$download_dir" && shasum -a 256 -c --quiet SHA256SUMS) ||
    fail "a downloaded file does not match SHA256SUMS, so nothing was installed. While CI replaces the edge release, its files can disagree for a minute; try again shortly."

  # The zip is unpacked before anything is replaced, so a broken one leaves the
  # installed app alone.
  ditto -x -k "$download_dir/Hercule-darwin-arm64.zip" "$download_dir/app"

  first_install=true
  [ -f "$plist_path" ] && first_install=false

  # SIGTERM makes the app quit the way choosing Quit does.
  app_was_running=false
  if is_app_running; then
    app_was_running=true
    printf 'Quitting Hercule.app\n'
    # The app may quit on its own between the check and the signal.
    pkill -TERM -U "$(id -u)" -f "$app_process_pattern" || true
    wait_until_fails is_app_running ||
      fail "Hercule.app did not quit within 30 seconds. Quit it and run this again; nothing was replaced."
  fi
  # The old app is moved aside rather than deleted, so it can be put back if
  # the new one cannot be moved in.
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

  # The binary is replaced last, just before the controller restarts, so the
  # controller never runs a binary newer than the app beside it.
  # The new binary is renamed over the old one rather than written into it.
  # The rename is atomic, so nothing ever runs half a file. And macOS caches a
  # signed executable's signature per file, so it refuses to run one that was
  # rewritten in place.
  mkdir -p "$bin_dir"
  cp "$download_dir/hercule-darwin-arm64" "$bin_dir/.hercule.new"
  chmod 755 "$bin_dir/.hercule.new"
  mv -f "$bin_dir/.hercule.new" "$bin_dir/hercule"
  printf 'Installed %s\n' "$bin_dir/hercule"

  cat > "$download_dir/$service_label.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$service_label</string>
	<key>ProgramArguments</key>
	<array>
		<string>$(escape_xml "$bin_dir/hercule")</string>
		<string>serve</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>$(escape_xml "$(build_service_path)")</string>
		<key>HERCULE_HOME</key>
		<string>$(escape_xml "$hercule_home")</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>$(escape_xml "$controller_log")</string>
	<key>StandardErrorPath</key>
	<string>$(escape_xml "$controller_log")</string>
</dict>
</plist>
EOF
  plutil -lint -s "$download_dir/$service_label.plist"

  # launchd opens the log before it starts the controller, and does not create
  # folders. The Hercule Home is the owner's alone (spec 13), which the
  # controller enforces at boot too.
  (umask 077 && mkdir -p "${controller_log%/*}")

  # `kickstart -k` restarts the controller with the job launchd already holds.
  # launchd reads the plist only when the job is loaded, so a changed plist
  # needs the job unloaded and loaded again.
  previous_pid=$(read_controller_pid)
  if is_service_loaded && cmp -s "$download_dir/$service_label.plist" "$plist_path"; then
    printf 'Restarting the controller\n'
    launchctl kickstart -k "$launchd_domain/$service_label"
  else
    if is_service_loaded; then
      printf 'Stopping the controller\n'
      launchctl bootout "$launchd_domain/$service_label" || true
      wait_until_fails is_service_loaded ||
        fail "launchd did not stop the controller within 30 seconds. See $controller_log."
    fi
    mkdir -p "${plist_path%/*}"
    cp "$download_dir/$service_label.plist" "$plist_path"
    printf 'Starting the controller\n'
    launchctl bootstrap "$launchd_domain" "$plist_path"
  fi

  # A controller that fails at boot, for example because another one holds its
  # port, exits at once, and launchd starts it again ten seconds later under a
  # new pid. So the controller counts as started once it runs under a new pid
  # and still runs under that pid three seconds later. launchd may also wait
  # those ten seconds before the first start, when the old controller ran for
  # less than ten seconds, so the wait for a new pid lasts 30 seconds.
  started_pid=""
  tries=0
  while [ -z "$started_pid" ]; do
    pid=$(read_controller_pid)
    if [ -n "$pid" ] && [ "$pid" != "$previous_pid" ]; then
      started_pid=$pid
    else
      tries=$((tries + 1))
      [ "$tries" -le 60 ] || fail "the controller did not start. See $controller_log for the reason."
      sleep 0.5
    fi
  done
  sleep 3
  [ "$(read_controller_pid)" = "$started_pid" ] ||
    fail "the controller stopped right after it started. See $controller_log for the reason."

  if $app_was_running; then
    open "$app"
  fi

  printf '\nHercule %s is installed, and the controller is running.\n' "$("$bin_dir/hercule" --version)"

  hercule_command=hercule
  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *)
      hercule_command="$bin_dir/hercule"
      # shellcheck disable=SC2016 # the line keeps $PATH for the profile to expand
      printf '\n%s is not on your PATH. To put it there, add this line to your shell profile:\n\n  export PATH="%s:$PATH"\n' "$bin_dir" "$bin_dir"
      ;;
  esac
  if [ "$hercule_home" != "$HOME/.hercule" ]; then
    hercule_command="HERCULE_HOME=$hercule_home $hercule_command"
  fi

  if $first_install; then
    printf '\nNext, open the setup page in your browser. This prints its address:\n\n  %s setup-url\n' "$hercule_command"
  fi
}

main "$@"
