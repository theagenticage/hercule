/**
 * The `gh` shim: a small shell script the runner writes into the directory
 * that goes at the front of every session's `PATH`, so that a session's `gh`
 * always runs with a GitHub token that is still valid.
 */
import { quoteShellWord } from "../credentials";

/**
 * Builds the text of the `gh` shim for the bin directory `binDir`.
 *
 * What the script does when a session runs `gh ...`:
 *
 * 1. It removes every `PATH` entry that is the same directory as `binDir`, so
 *    the `gh` it runs at the end is the real one and not the shim itself. An
 *    entry counts when it is the same string, and also when the shell's `-ef`
 *    test says it is the same directory: a trailing slash or a symlink would
 *    otherwise leave the shim on `PATH` and make `exec gh` run it again, forever.
 *    An empty entry means the current directory, so it is tested as `.`. When
 *    no entry is left, the script prints `gh: command not found` and exits 127,
 *    because an empty `PATH` would search the current directory.
 * 2. When `GH_TOKEN` is set, it runs `hercule github-token`, which asks the
 *    runner for a fresh token. Only its stdout is captured; its stderr goes
 *    straight to the caller, and carries the reason when it fails. When it
 *    exits 0 and prints a token, the script sets `GH_TOKEN` to it for this one
 *    `gh` run. Otherwise (it failed, or printed nothing) the script prints one
 *    line on stderr that says it runs `gh` with the session's original token
 *    and how to run `gh` as the machine's own login, and leaves `GH_TOKEN` as it
 *    was. An empty `GH_TOKEN` is never set, because `gh` would then fall back to
 *    the machine's own login. The script never refuses to run `gh`.
 * 3. It replaces itself with the real `gh` (`exec`), so `gh` gets the terminal,
 *    the signals and its exit code is the caller's.
 *
 * When `GH_TOKEN` is not set, the shim changes nothing and prints nothing. That
 * covers two cases it cannot tell apart: the explicit opt-out
 * `env -u GH_TOKEN gh ...`, and a session that started with no token (its
 * Connection had none). Running `gh` silently as the machine's own login in the
 * second case is an accepted fallback, decided by Rogier on 2026-10-26.
 *
 * It is a shell script and not a symlink to the `hercule` binary, because every
 * `gh` call would then start the whole binary, and for the common case, where
 * no token is needed, that cost is paid for nothing. The shell is already on
 * every machine and starts in a few milliseconds. For the same reason `binDir`
 * is written into the script as an absolute path, and the script uses only
 * shell builtins until it runs `hercule` or `gh`.
 */
export const buildGhShim = (binDir: string): string => `#!/bin/sh
# Runs gh with a fresh GitHub token. The Hercule runner writes this file at
# every start; changes made here are lost.
bin=${quoteShellWord(binDir)}

# Remove every PATH entry that is the bin directory, spelled any way (same string, or
# the same directory by \`-ef\`: trailing slash, symlink, or an empty entry, which means
# the current directory), keeping the other entries (also the empty ones) in order.
rest=$PATH: path= sep=
while [ -n "$rest" ]; do
  entry=\${rest%%:*}
  rest=\${rest#*:}
  if [ "$entry" != "$bin" ] && ! [ "\${entry:-.}" -ef "$bin" ]; then
    path=$path$sep$entry
    sep=:
  fi
done
# No entry kept: an empty PATH would search the current directory.
if [ -z "$sep" ]; then
  echo "gh: command not found" >&2
  exit 127
fi
PATH=$path

if [ -n "\${GH_TOKEN+x}" ]; then
  if out=$("$bin/hercule" github-token) && [ -n "$out" ]; then
    GH_TOKEN=$out
    export GH_TOKEN
  else
    echo "hercule: running gh with the session's original token. To act as this machine's own gh login instead, ask the user once in this thread, then run: env -u GH_TOKEN gh ..." >&2
  fi
fi

exec gh "$@"
`;
