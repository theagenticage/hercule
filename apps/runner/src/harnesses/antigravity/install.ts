/**
 * Installs Antigravity (`agy`) on a machine.
 */
import type * as Effect from "effect/Effect";
import { ANTIGRAVITY_VERSION } from "@hercule/home/version";
import type { InstallOutcome } from "../index";
import { makeInstall } from "../install";
import type { Run } from "../process";

/**
 * The SHA-256 digest of each release asset, keyed by the asset's name without
 * `.tar.gz`. These belong to `ANTIGRAVITY_VERSION`: when that version changes,
 * replace all six with the digests GitHub lists for the new release. A
 * download whose digest differs is never installed.
 */
const ASSET_CHECKSUMS: Readonly<Record<string, string>> = {
  agy_cli_linux_arm64: "e5b5d7ca1dda2cfdc0b09c72931320c3ef5c481a14dbda137304107ce6e776b1",
  agy_cli_linux_arm64_musl: "455d20cc37507058bd9287d47d51aa7e6110351eb717fbf17e19619a7dc9d32e",
  agy_cli_linux_x64: "8d9913298602049ef29e9669f35252b6b79571979ce1bd0fb27753c7bac84114",
  agy_cli_linux_x64_musl: "a12514fb33e8835186082a00b60725f6fb15941ba061f0403347b86c4dbd8f46",
  agy_cli_mac_arm64: "9e25108f3ea70cc6c846d88b9397456d13ae472a010016c3d625eb3fe99afc3a",
  agy_cli_mac_x64: "91fee043a384b76cee5d5f1568b946ab2f25bf38c938f0bd7c4b27fefa0c4e43",
};

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
  echo "The download of $asset does not match the checksum pinned for Antigravity $version, so nothing was installed." >&2
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
 * Builds the Antigravity installer with the given digests in place of the
 * pinned ones. Only tests call it, because they serve an archive of their own.
 * Production code uses `makeAntigravityInstall`.
 */
export const makeAntigravityInstallWithChecksums = (
  run: Run,
  checksums: Readonly<Record<string, string>>,
): ((env: Readonly<Record<string, string | undefined>>) => Effect.Effect<InstallOutcome>) =>
  makeInstall(run, ["bash", "-c", buildInstallScript(checksums)]);

/**
 * Builds the Antigravity installer. It installs the release this build pins,
 * with a command of our own: Google's install script takes no version and
 * does nothing when `agy` is already there, so it can neither pin a release
 * nor move an existing install to the pinned one.
 */
export const makeAntigravityInstall = (
  run: Run,
): ((env: Readonly<Record<string, string | undefined>>) => Effect.Effect<InstallOutcome>) =>
  makeAntigravityInstallWithChecksums(run, ASSET_CHECKSUMS);
