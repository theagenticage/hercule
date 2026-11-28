/**
 * Runs a command on the virtual screen of the desktop container (`Dockerfile`
 * in this folder), after building the image when this machine does not have
 * it. Exits with the command's exit code.
 *
 *   node apps/desktop/container/run.ts [--platform linux/amd64|linux/arm64]
 *     [--bring-back <path>]... -- <command> [<argument>...]
 *
 * Without `--platform` the container runs on this machine's own architecture,
 * so nothing is emulated.
 *
 * What the container sees as `/repo` depends on the host:
 *
 * - On Linux it is the checkout itself, with the `node_modules` installed on
 *   the host.
 * - On macOS the checkout's `node_modules` holds macOS binaries, which do not
 *   run on Linux. So the command runs in a scratch copy of the files git
 *   tracks or would track, after a `pnpm install` inside the container. pnpm
 *   keeps its store in the cache volume, so after the first run the install
 *   mostly links. Afterwards each `--bring-back` path, relative to the
 *   repository root, replaces the checkout's own, whether the command passed
 *   or failed. Then the copy is deleted.
 *
 * Fails when the image cannot be built or Docker cannot start the container.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ensureImage, parsePlatformOption, type ImagePlatform } from "./image.ts";

const REPOSITORY_ROOT = join(import.meta.dirname, "../../..");

/** The options before `--`, and the command after it. */
interface RunRequest {
  readonly platform: ImagePlatform;
  readonly bringBackPaths: ReadonlyArray<string>;
  readonly command: ReadonlyArray<string>;
}

/**
 * Parses the command-line arguments of this script. Fails when there is no
 * `--` followed by a command.
 */
export function parseRunRequest(argumentList: ReadonlyArray<string>): RunRequest {
  const separator = argumentList.indexOf("--");
  const command = separator === -1 ? [] : argumentList.slice(separator + 1);
  if (command.length === 0) {
    throw new Error(
      "Usage: node apps/desktop/container/run.ts [--platform linux/amd64|linux/arm64] [--bring-back <path>]... -- <command> [<argument>...]",
    );
  }
  const options = argumentList.slice(0, separator);
  const bringBackPaths = options.flatMap((option, index) =>
    option === "--bring-back" && options[index + 1] !== undefined ? [options[index + 1]!] : [],
  );
  return { platform: parsePlatformOption(options), bringBackPaths, command };
}

/**
 * Copies the files git tracks, and the new files it does not ignore, from the
 * checkout into the scratch folder `copy`. A symbolic link is copied as a
 * link, as git stores it.
 */
function copyCheckout(copy: string): void {
  const listing = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: REPOSITORY_ROOT, encoding: "utf8", maxBuffer: Infinity },
  );
  if (listing.status !== 0) throw new Error(`git ls-files failed: ${listing.stderr}`);
  for (const file of listing.stdout.split("\0")) {
    const source = join(REPOSITORY_ROOT, file);
    // A tracked file deleted in the checkout is still listed.
    if (file === "" || !existsSync(source)) continue;
    mkdirSync(dirname(join(copy, file)), { recursive: true });
    if (lstatSync(source).isSymbolicLink()) symlinkSync(readlinkSync(source), join(copy, file));
    else cpSync(source, join(copy, file));
  }
}

/** Replaces each path in the checkout with the copy's version of it, when the copy has one. */
function bringBack(copy: string, paths: ReadonlyArray<string>): void {
  for (const path of paths) {
    if (!existsSync(join(copy, path))) continue;
    rmSync(join(REPOSITORY_ROOT, path), { recursive: true, force: true });
    cpSync(join(copy, path), join(REPOSITORY_ROOT, path), { recursive: true });
    console.error(`run.ts: brought back ${path}`);
  }
}

/** Runs the command in the container with `repository` mounted as `/repo`. Returns its exit code. */
function runInContainer(
  platform: ImagePlatform,
  repository: string,
  needsInstall: boolean,
  command: ReadonlyArray<string>,
): number {
  const image = ensureImage(platform);
  const setup = needsInstall
    ? 'mkdir -p "$HOME" && pnpm install --frozen-lockfile && exec "$@"'
    : 'mkdir -p "$HOME" && exec "$@"';
  // The flags are explained in `Dockerfile`.
  const run = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--init",
      "--shm-size=1g",
      "--security-opt",
      "seccomp=unconfined",
      "--platform",
      platform,
      "--user",
      `${process.getuid!()}:${process.getgid!()}`,
      "-e",
      "HOME=/tmp/home",
      "-e",
      "npm_config_store_dir=/cache/pnpm-store",
      "-v",
      "hercule-desktop-cache:/cache",
      "-v",
      `${repository}:/repo`,
      "-w",
      "/repo",
      image,
      "sh",
      "-c",
      setup,
      "sh",
      ...command,
    ],
    { stdio: "inherit" },
  );
  if (run.error) throw run.error;
  return run.status ?? 1;
}

if (import.meta.main) {
  const request = parseRunRequest(process.argv.slice(2));
  if (process.platform !== "darwin") {
    process.exit(runInContainer(request.platform, REPOSITORY_ROOT, false, request.command));
  }
  const copy = mkdtempSync(join(tmpdir(), "hercule-desktop-container-"));
  try {
    copyCheckout(copy);
    console.error(`run.ts: running in a copy of the checkout at ${copy}`);
    const status = runInContainer(request.platform, copy, true, request.command);
    bringBack(copy, request.bringBackPaths);
    process.exitCode = status;
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}
