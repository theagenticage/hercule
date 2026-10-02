/**
 * Tests what `pnpm build:desktop` packaged: the release package's signature,
 * what its `app.asar` holds, its Electron fuses (spec 17, §Security
 * baseline), that it starts and quits, and that the test package the other
 * suites run differs from it in one fuse only.
 *
 * Fuses are switches compiled into the Electron binary, which electron-builder
 * flips when it packages the app. Nothing at run time can turn them back.
 */
import { listPackage } from "@electron/asar";
import { FuseV1Options, getCurrentFuseWire } from "@electron/fuses";
import { execFile, spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  buildAppArgs,
  findExecutable,
  findPackagedApp,
  writeSettings,
  type PackageKind,
} from "../../apps/desktop/scripts/packaged-app";
import { buildAppEnv } from "../../apps/desktop/scripts/processes";
import {
  createUserDataDirForTest,
  findUnusedLoopbackUrl,
  runSecondInstance,
  waitForExit,
} from "./harness";

/**
 * The fuses spec 17 sets, by name, and the state each must be in.
 *
 * The other fuses on the wire keep Electron's defaults and are not checked:
 *
 * - `EnableCookieEncryption` and `LoadBrowserProcessSpecificV8Snapshot` are
 *   off by default. The app keeps no cookies of its own and uses no V8
 *   snapshot.
 * - Electron 44 adds a ninth fuse, `WasmTrapHandlers`, which
 *   `@electron/fuses` 1.8.0 has no name for, so it reads as `fuse 8`. It is on
 *   by default and lets V8 run WebAssembly faster by catching out-of-bounds
 *   reads in a signal handler. It does not open a way into the app, so spec 17
 *   leaves it alone.
 */
const RELEASE_FUSES = {
  RunAsNode: "off",
  EnableNodeOptionsEnvironmentVariable: "off",
  EnableNodeCliInspectArguments: "off",
  EnableEmbeddedAsarIntegrityValidation: "on",
  OnlyLoadAppFromAsar: "on",
  // A page loaded from `file:` would otherwise get privileges no page of this
  // app needs: the app serves its own files over `app:`.
  GrantFileProtocolExtraPrivileges: "off",
} as const satisfies Partial<Record<keyof typeof FuseV1Options, "on" | "off">>;

/**
 * Reads every fuse off the packaged app of the given kind, keyed by its name.
 *
 * A fuse `@electron/fuses` has no name for is keyed `fuse <index>`. The wire
 * stores each fuse as one ASCII character, "1" when it is on and "0" when it
 * is off; a fuse in any other state reads as its character code.
 */
async function readFuses(kind: PackageKind): Promise<Record<string, string>> {
  const wire: Record<string, unknown> = await getCurrentFuseWire(findPackagedApp(kind));
  return Object.fromEntries(
    Object.entries(wire)
      .filter(([index]) => index !== "version")
      .map(([index, state]) => [
        FuseV1Options[Number(index)] ?? `fuse ${index}`,
        describeFuseState(state),
      ]),
  );
}

/** Returns "on" or "off" for a fuse's character code on the wire, or the code itself. */
function describeFuseState(state: unknown): string {
  if (state === "1".charCodeAt(0)) return "on";
  if (state === "0".charCodeAt(0)) return "off";
  return String(state);
}

describe("the release package", () => {
  it("has its fuses set as spec 17 lists them", async () => {
    const fuses = await readFuses("release");

    const checked = Object.fromEntries(
      Object.keys(RELEASE_FUSES).map((name) => [name, fuses[name]]),
    );
    expect(checked).toEqual(RELEASE_FUSES);
  });

  it("holds only out/ and package.json in its app.asar", () => {
    const archive = join(findPackagedApp("release"), "Contents/Resources/app.asar");

    // Main, the preload and the renderer are bundled into out/. Anything else
    // here, such as node_modules or source, ships to every user for nothing.
    const unexpected = listPackage(archive, { isPack: false }).filter(
      (path) => path !== "/package.json" && path !== "/out" && !path.startsWith("/out/"),
    );
    expect(unexpected).toEqual([]);
  });

  it("is signed, and its signature verifies", async () => {
    // Fails with codesign's own explanation when the signature is missing,
    // does not cover every file, or does not match the files.
    const { stderr } = await promisify(execFile)("codesign", [
      "--verify",
      "--deep",
      "--strict",
      "--verbose=2",
      findPackagedApp("release"),
    ]);
    expect(stderr).toContain("valid on disk");
    expect(stderr).toContain("satisfies its Designated Requirement");
  });

  it("starts, hands a second copy on the same user data directory over to the first, and quits on SIGTERM", async () => {
    // Every other test runs the test package, so this is the one run of what
    // ships. It is started as a plain process: its inspect arguments are off,
    // so Playwright cannot drive it.
    //
    // It also refuses `--hercule-binary`, so with no controller saved its
    // first run would look for Hercule with this Mac's own binary. A saved
    // controller that nothing answers at keeps it from looking: the app opens
    // on the connect screen instead.
    const userDataDir = createUserDataDirForTest();
    writeSettings(userDataDir, { controllerUrl: await findUnusedLoopbackUrl() });
    const first = spawn(findExecutable("release"), buildAppArgs(userDataDir), {
      env: buildAppEnv(),
      stdio: "ignore",
    });
    onTestFinished(() => {
      if (first.exitCode === null && first.signalCode === null) first.kill("SIGKILL");
    });

    // Chromium creates this link in the user data directory once the app holds
    // its single-instance lock.
    await expect
      .poll(() => readdirSync(userDataDir).includes("SingletonLock"), { timeout: 10_000 })
      .toBe(true);
    expect(await runSecondInstance("release", userDataDir)).toBe(0);
    expect({ exitCode: first.exitCode, signal: first.signalCode }).toEqual({
      exitCode: null,
      signal: null,
    });

    // SIGTERM makes the app quit the way `app.quit()` does.
    first.kill("SIGTERM");
    expect(await waitForExit(first, "the release app")).toBe(0);
  });
});

describe("the test package", () => {
  it("differs from the release package only in turning on the inspect arguments", async () => {
    const release = await readFuses("release");
    const test = await readFuses("test");

    expect(test).toEqual({ ...release, EnableNodeCliInspectArguments: "on" });
  });
});
