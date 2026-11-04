/**
 * Tests the login token against the keyring a Linux desktop really has, with
 * no mock keychain (spec 17, §Auth and the token). Every other test runs on
 * the mock keychain's fixed key, so none of them can tell whether the token
 * is encrypted with a key a keyring keeps.
 *
 * - With a keyring (GNOME Keyring, unlocked, on a D-Bus session of the
 *   test's own), the token is saved encrypted with the keyring's key, and a
 *   relaunch is still signed in.
 * - In the mock keychain mode, which every other test uses, the app uses
 *   the `basic_text` backend and its fixed key, even on a desktop that has a
 *   keyring, so a test never reaches the developer's own keyring.
 * - Without one, Chromium picks the `basic_text` backend, whose key is
 *   public. The app then saves no token and shows the sheet that says so,
 *   while the user stays signed in for the run.
 *
 * The tests run on Linux only, and the keyring ones only where `dbus-daemon`,
 * `gnome-keyring-daemon` and `secret-tool` are installed, as in the
 * container of `apps/desktop/container`. The keyring is private to the test:
 * it never touches the developer's own. Run `pnpm build:desktop` and
 * `pnpm build:binary` first.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  buildAppArgs,
  buildBinaryPathArgument,
  buildMockKeychainArgs,
  findExecutable,
  quitApp,
  readSettings,
  writeSettings,
} from "../../apps/desktop/scripts/packaged-app";
import { buildAppEnv } from "../../apps/desktop/scripts/processes";
import {
  createUserDataDirForTest,
  signInAndReadToken,
  startControllerForTest,
  type PageGlobal,
} from "./harness";

const onLinux = process.platform === "linux";

/** Returns true when running `command` with `--version` finds the program. */
const isInstalled = (command: string): boolean =>
  spawnSync(command, ["--version"], { stdio: "ignore" }).error === undefined;

const hasKeyring =
  onLinux &&
  ["dbus-daemon", "dbus-send", "gnome-keyring-daemon", "secret-tool"].every((command) =>
    isInstalled(command),
  );

/**
 * The environment variables Chromium reads to recognise the desktop
 * environment on Linux. Without them it picks the `basic_text` backend.
 */
const DESKTOP_ENVIRONMENT_VARIABLES = [
  "XDG_CURRENT_DESKTOP",
  "DESKTOP_SESSION",
  "GNOME_DESKTOP_SESSION_ID",
  "KDE_FULL_SESSION",
];

/**
 * Starts a D-Bus session and, on it, a GNOME Keyring with its default
 * collection unlocked, for the current test, and stops both when the test
 * finishes. Returns the variables an app needs to find the keyring.
 */
async function startKeyringForTest(): Promise<Record<string, string>> {
  const directory = mkdtempSync(join(tmpdir(), "hercule-keyring-"));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "run"), { mode: 0o700 });

  const bus = spawn("dbus-daemon", ["--session", "--nofork", "--print-address=1"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  onTestFinished(() => {
    bus.kill();
  });
  const address = await readFirstLine(bus);
  const env = {
    ...buildAppEnv(),
    DBUS_SESSION_BUS_ADDRESS: address,
    XDG_DATA_HOME: join(directory, "data"),
    XDG_RUNTIME_DIR: join(directory, "run"),
  };

  // The password on standard input unlocks the login keyring, which the
  // daemon creates on a first start. Without a default collection, the first
  // use would ask the user to create one.
  const daemon = spawn(
    "gnome-keyring-daemon",
    ["--foreground", "--unlock", "--components=secrets"],
    {
      env,
      stdio: ["pipe", "ignore", "inherit"],
    },
  );
  onTestFinished(() => {
    daemon.kill();
  });
  daemon.stdin.end("keyring-password");

  // The daemon must own the keyring's bus name before anything asks for it.
  // A request that comes first makes D-Bus start a second daemon, which is
  // locked and waits for a person to type its password.
  await expect
    .poll(
      () =>
        spawnSync(
          "dbus-send",
          [
            "--session",
            "--print-reply",
            "--dest=org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus.NameHasOwner",
            "string:org.freedesktop.secrets",
          ],
          { env, encoding: "utf8", timeout: 5000 },
        ).stdout,
      { message: "the keyring did not start", timeout: 15_000 },
    )
    .toContain("boolean true");
  // A store succeeds only once the default collection is unlocked.
  await expect
    .poll(
      () =>
        spawnSync("secret-tool", ["store", "--label=readiness", "readiness", "1"], {
          env,
          input: "x",
          timeout: 5000,
        }).status,
      { message: "the keyring did not unlock", timeout: 15_000 },
    )
    .toBe(0);
  return { DBUS_SESSION_BUS_ADDRESS: address, XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR };
}

/** Returns the first line `child` writes to its standard output. */
function readFirstLine(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      text += chunk;
      const end = text.indexOf("\n");
      if (end >= 0) resolve(text.slice(0, end));
    });
    child.once("error", reject);
    child.once("exit", () => reject(new Error(`${String(child.spawnfile)} exited early`)));
  });
}

/** An app started by `launchOnDesktop`, and a way to quit it. */
interface LaunchedOnDesktop {
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly close: () => Promise<void>;
}

/**
 * Starts the test package on `userDataDir` for the current test. It passes no
 * mock keychain arguments unless `extraArgs` holds them, so by default the app
 * encrypts with what the machine has. `env` is added to the environment, after
 * the variables that name the desktop environment are removed from it.
 */
async function launchOnDesktop(
  userDataDir: string,
  env: Record<string, string>,
  extraArgs: ReadonlyArray<string> = [],
): Promise<LaunchedOnDesktop> {
  const baseEnv = buildAppEnv();
  for (const name of DESKTOP_ENVIRONMENT_VARIABLES) delete baseEnv[name];
  const app = await _electron.launch({
    executablePath: findExecutable("test"),
    args: [...buildAppArgs(userDataDir), buildBinaryPathArgument(userDataDir), ...extraArgs],
    env: { ...baseEnv, ...env },
    colorScheme: null,
  });
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= quitApp(app));
  onTestFinished(close);
  const page = await app.firstWindow();
  await page.waitForLoadState("load");
  return { app, page, close };
}

/** Returns the first three characters of the encrypted token saved in `userDataDir`'s settings file. */
const readSavedTokenPrefix = (userDataDir: string): string =>
  Buffer.from(readSettings(userDataDir)["token"] as string, "base64")
    .subarray(0, 3)
    .toString("latin1");

/** Reads the token main decrypts from the settings file, as the page asks for it at start. */
const readStoredToken = (page: Page): Promise<string | null> =>
  page.evaluate(() => (globalThis as PageGlobal).bridge.token.read());

describe.skipIf(!onLinux)("the login token on Linux", () => {
  it.skipIf(!hasKeyring)(
    "is encrypted with the keyring's key, and a relaunch is still signed in",
    async () => {
      const keyring = await startKeyringForTest();
      const controller = await startControllerForTest({ setUp: true });
      const userDataDir = createUserDataDirForTest();
      writeSettings(userDataDir, { controllerUrl: controller.url });
      const env = { ...keyring, XDG_CURRENT_DESKTOP: "GNOME" };

      const first = await launchOnDesktop(userDataDir, env);
      expect(
        await first.app.evaluate(({ safeStorage }) => safeStorage.getSelectedStorageBackend()),
      ).toBe("gnome_libsecret");
      const token = await signInAndReadToken(first.page, controller.url);
      await expect
        .poll(() => readSettings(userDataDir)["token"], { message: "the token was not saved" })
        .toBeTypeOf("string");
      await first.close();

      // The file holds nothing readable. Chromium starts a value that a
      // keyring's key encrypted with `v11`, and a value that the fixed key
      // of `basic_text` encrypted with `v10`.
      const file = readFileSync(join(userDataDir, "settings.json"), "utf8");
      expect(file).not.toContain(token);
      const saved = Buffer.from(readSettings(userDataDir)["token"] as string, "base64");
      expect(saved.toString("latin1")).not.toContain(token);
      expect(readSavedTokenPrefix(userDataDir)).toBe("v11");

      const second = await launchOnDesktop(userDataDir, env);
      expect(await readStoredToken(second.page)).toBe(token);
    },
  );

  it.skipIf(!hasKeyring)(
    "never uses the desktop's keyring in the mock keychain mode, even on a desktop that has one",
    async () => {
      const keyring = await startKeyringForTest();
      const controller = await startControllerForTest({ setUp: true });
      const userDataDir = createUserDataDirForTest();
      writeSettings(userDataDir, { controllerUrl: controller.url });

      // The environment of a GNOME desktop with its keyring running: a test
      // started there must not reach that keyring.
      const { app, page } = await launchOnDesktop(
        userDataDir,
        { ...keyring, XDG_CURRENT_DESKTOP: "GNOME" },
        buildMockKeychainArgs(),
      );
      expect(await app.evaluate(({ safeStorage }) => safeStorage.getSelectedStorageBackend())).toBe(
        "basic_text",
      );
      await signInAndReadToken(page, controller.url);
      await expect
        .poll(() => readSettings(userDataDir)["token"], { message: "the token was not saved" })
        .toBeTypeOf("string");

      // `v10` marks the fixed key of `basic_text`, `v11` a keyring's key.
      expect(readSavedTokenPrefix(userDataDir)).toBe("v10");
    },
  );

  it("saves no token, and says so, when the desktop has no keyring", async () => {
    const controller = await startControllerForTest({ setUp: true });
    const userDataDir = createUserDataDirForTest();
    writeSettings(userDataDir, { controllerUrl: controller.url });

    const { app, page } = await launchOnDesktop(userDataDir, {});
    expect(await app.evaluate(({ safeStorage }) => safeStorage.getSelectedStorageBackend())).toBe(
      "basic_text",
    );
    // The sheet is a native dialog that no page can read, so the test records
    // what main asks it to show.
    await app.evaluate(({ dialog }) => {
      const shown: Array<string> = [];
      (globalThis as { shownWarnings?: Array<string> }).shownWarnings = shown;
      dialog.showMessageBox = ((_window: unknown, options: { message: string }) => {
        shown.push(options.message);
        return Promise.resolve({ response: 0, checkboxChecked: false });
      }) as unknown as typeof dialog.showMessageBox;
    });

    await signInAndReadToken(page, controller.url);

    await expect
      .poll(
        () => app.evaluate(() => (globalThis as { shownWarnings?: Array<string> }).shownWarnings),
        { message: "the sheet was not shown" },
      )
      .toEqual([
        "Hercule could not save your sign-in to the keyring, so you will need to sign in again next time.",
      ]);
    expect(readSettings(userDataDir)).not.toHaveProperty("token");
    // The user stays signed in for this run: the sign-in screen is gone.
    await expect
      .poll(() => page.getByLabel("Password", { exact: true }).count(), {
        message: "the sign-in screen stayed",
      })
      .toBe(0);
  });
});
