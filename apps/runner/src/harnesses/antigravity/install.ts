/**
 * Installs Antigravity (`agy`) on a machine.
 */
import type * as Effect from "effect/Effect";
import { ANTIGRAVITY_CHECKSUMS, ANTIGRAVITY_VERSION } from "@hercule/home/version";
import type { InstallOutcome } from "../index";
import { makeInstall } from "../install";
import type { Run } from "../process";

/**
 * Builds a shell script that runs on macOS (bash 3.2) and Linux. It stops at
 * the first error and uses only curl, tar, mktemp, uname, ldd, grep,
 * sha256sum (or shasum on macOS), chmod, mv, mkdir and rm.
 *
 * The release asset for the machine is `agy_cli_<os>_<arch>.tar.gz`, with
 * `<os>_<arch>` one of mac_arm64, mac_x64, linux_x64, linux_arm64, and
 * `_musl` appended on Linux with the musl C library. The script finds the C
 * library the system itself runs on: musl's own library file exists, or `ldd`
 * names musl. A musl loader file alone proves nothing, because Debian and
 * Ubuntu install one with their `musl` package. The archive holds one file,
 * `antigravity`.
 *
 * The download is checked against `checksums` before it is unpacked, and the
 * script fails with a plain sentence when the digest differs or when the
 * asset has no entry. curl accepts only https, also across redirects, and
 * gives up on a stalled connection: the runner's deadline stops only bash, so
 * a curl that waits forever would outlive it.
 *
 * The file is unpacked into a staging folder inside `~/.local/bin`, so the
 * final `mv` stays on one file system and is atomic. That `mv` is the last
 * step: an install that fails earlier never replaces a working `agy`. The
 * staging folder is removed on exit, whether the install worked or not. The
 * script refuses a staged file that is not a regular file, and a folder (or a
 * link to one) at `~/.local/bin/agy`, because `mv` would move the file into it
 * and report success.
 */
const buildInstallScript = (checksums: Readonly<Record<string, string>>): string => `set -eu
version=${ANTIGRAVITY_VERSION}

unsupported() {
  echo "Antigravity has no release for the system $(uname -s) $(uname -m)." >&2
  exit 1
}

case "$(uname -s)" in
  Darwin) os=mac ;;
  Linux) os=linux ;;
  *) unsupported ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) unsupported ;;
esac

libc=""
if [ "$os" = linux ]; then
  if [ -e /lib/libc.musl-x86_64.so.1 ] || [ -e /lib/libc.musl-aarch64.so.1 ] || ldd /bin/ls 2>&1 | grep -q musl; then
    libc=_musl
  fi
fi

asset="agy_cli_\${os}_\${arch}\${libc}"
case "$asset" in
${Object.entries(checksums)
  .map(([name, digest]) => `  ${name}) expected=${digest} ;;`)
  .join("\n")}
  *) echo "This build pins no checksum for $asset, so nothing was installed." >&2; exit 1 ;;
esac

bin="$HOME/.local/bin"
mkdir -p "$bin"
if [ -d "$bin/agy" ]; then
  echo "$bin/agy is a folder, or a link to one, so nothing was installed. Remove it and install again." >&2
  exit 1
fi
stage="$(mktemp -d "$bin/.agy-install.XXXXXX")"
trap 'rm -rf "$stage"' EXIT

curl -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 30 --max-time 240 -o "$stage/agy.tar.gz" "https://github.com/google-antigravity/antigravity-cli/releases/download/$version/$asset.tar.gz"
if command -v sha256sum >/dev/null 2>&1; then
  set -- $(sha256sum "$stage/agy.tar.gz")
else
  set -- $(shasum -a 256 "$stage/agy.tar.gz")
fi
if [ "$1" != "$expected" ]; then
  echo "The file downloaded for $asset is not the one this Hercule build was made for, so nothing was installed. Update Hercule, or report this problem if it is already up to date." >&2
  exit 1
fi
tar -xzf "$stage/agy.tar.gz" -C "$stage" antigravity
if [ -L "$stage/antigravity" ] || [ ! -f "$stage/antigravity" ]; then
  echo "The archive of $asset holds an antigravity that is not a regular file, so nothing was installed." >&2
  exit 1
fi
chmod 755 "$stage/antigravity"
mv -f "$stage/antigravity" "$bin/agy"
`;

/**
 * Builds the Antigravity installer. It installs the release this build pins,
 * with a command of our own: Google's install script takes no version and
 * does nothing when `agy` is already there, so it can neither pin a release
 * nor move an existing install to the pinned one. The table of checksums is a
 * parameter so that tests can serve an archive of their own.
 */
export const makeAntigravityInstall = (
  run: Run,
  checksums: Readonly<Record<string, string>> = ANTIGRAVITY_CHECKSUMS,
): ((env: Readonly<Record<string, string | undefined>>) => Effect.Effect<InstallOutcome>) =>
  makeInstall(run, ["bash", "-c", buildInstallScript(checksums)]);
