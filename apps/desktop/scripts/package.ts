/**
 * Packages the desktop app for the machine it runs on, as `pnpm package`.
 * It builds two packages, with the config in `electron-builder.yml`:
 *
 * - the release package, into `dist/release`: `Hercule.app` on macOS, a
 *   `.deb` and an Arch Linux package on Linux;
 * - the test package, into `dist/test`: the same app with the Node inspector
 *   fuse on, which Playwright needs (see `electron-builder.yml`). On macOS it
 *   is signed ad hoc, so the real signature never covers that fuse. On Linux
 *   it is an unpacked folder, because the tests run its executable in place.
 *
 * With `--unpacked-only`, the Linux release package is the unpacked folder
 * too, so no `.deb` or Arch Linux package is built. The end-to-end tests read
 * only that folder, and fpm takes about a minute to build the two packages.
 * On macOS both packages are unpacked already, so the flag changes nothing.
 *
 * Fails with electron-builder's exit code when either build fails, and on a
 * platform the app is not packaged for.
 */
import { spawnSync } from "node:child_process";

const TEST_PACKAGE = [
  "--config.directories.output=dist/test",
  "--config.electronFuses.enableNodeCliInspectArguments=true",
];

const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--unpacked-only");
if (unknownArguments.length > 0) {
  console.error(
    `Unknown arguments: ${unknownArguments.join(" ")}. The only one is --unpacked-only.`,
  );
  process.exit(1);
}
const unpackedOnly = process.argv.includes("--unpacked-only");

const BUILDS_BY_PLATFORM: Record<string, ReadonlyArray<ReadonlyArray<string>>> = {
  darwin: [["--mac"], ["--mac", ...TEST_PACKAGE, "--config.mac.identity=null"]],
  linux: [
    unpackedOnly ? ["--linux", "dir"] : ["--linux", "deb", "pacman"],
    ["--linux", "dir", ...TEST_PACKAGE],
  ],
};

const builds = BUILDS_BY_PLATFORM[process.platform];
if (builds === undefined) {
  console.error(`The desktop app is packaged on macOS and Linux, not on ${process.platform}.`);
  process.exit(1);
}
for (const build of builds) {
  const result = spawnSync("electron-builder", [...build], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
