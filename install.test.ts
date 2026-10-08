import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";

const script = fileURLToPath(new URL("install.sh", import.meta.url));

const launchAgentPath = join("Library", "LaunchAgents", "sh.hercule.service.plist");
const systemdUnitPath = join(".config", "systemd", "user", "hercule.service");

/** How install.sh is set up: its HERCULE_HOME, and any installed service unit. */
interface InstallSetup {
  /**
   * Returns the HERCULE_HOME install.sh runs with, given the home folder, or
   * undefined to leave it unset. By default it is `<home>/.hercule`.
   */
  readonly buildHerculeHome?: (home: string) => string | undefined;
  /** The content of an installed LaunchAgent's plist, if there is one (macOS). */
  readonly launchAgent?: string;
  /** The content of an installed systemd unit, if there is one (Linux). */
  readonly systemdUnit?: string;
}

/** What one run of install.sh did. */
interface InstallResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** The throwaway home folder the run used as `HOME`. */
  readonly home: string;
  /** The throwaway folder the run installed the app in. */
  readonly applicationsDir: string;
}

/**
 * Runs install.sh with a throwaway home folder, a throwaway folder in place of
 * /Applications, and the release read from `releaseDir`. Both folders are
 * deleted when the test finishes. The app folder is never /Applications, so a
 * run never quits or replaces the app of the person running the tests.
 */
function runInstall(releaseDir: string, setup: InstallSetup = {}): InstallResult {
  const home = makeTemporaryDir("hercule-install-home-");
  const applicationsDir = makeTemporaryDir("hercule-install-applications-");
  if (setup.launchAgent !== undefined) {
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(join(home, launchAgentPath), setup.launchAgent);
  }
  if (setup.systemdUnit !== undefined) {
    mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
    writeFileSync(join(home, systemdUnitPath), setup.systemdUnit);
  }
  const herculeHome = (setup.buildHerculeHome ?? ((home) => join(home, ".hercule")))(home);
  const result = spawnSync("sh", [script], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: home,
      ...(herculeHome === undefined ? {} : { HERCULE_HOME: herculeHome }),
      HERCULE_RELEASE_URL: pathToFileURL(releaseDir).href,
      HERCULE_APPLICATIONS_DIR: applicationsDir,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    home,
    applicationsDir,
  };
}

/**
 * Builds the plist of an installed LaunchAgent whose environment holds
 * `environment`.
 */
function buildLaunchAgent(environment: Readonly<Record<string, string>>): string {
  const entries = Object.entries(environment)
    .map(([key, value]) => `<key>${key}</key><string>${value}</string>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>sh.hercule.service</string>
<key>EnvironmentVariables</key><dict>${entries}</dict>
</dict></plist>
`;
}

/**
 * Builds the content of an installed systemd unit whose environment holds
 * `environment`.
 */
function buildSystemdUnit(environment: Readonly<Record<string, string>>): string {
  const entries = Object.entries(environment)
    .map(([key, value]) => `Environment="${key}=${value}"`)
    .join("\n");
  return `[Unit]
Description=Hercule

[Service]
Type=simple
${entries}
ExecStart=/home/user/.local/bin/hercule runner
Restart=always

[Install]
WantedBy=default.target
`;
}

/** Creates a temporary folder that is deleted when the test finishes. */
function makeTemporaryDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Writes a release folder holding fake assets and a SHA256SUMS whose content is
 * `sha256sums`, and returns its path. `assets` names the files written beside
 * SHA256SUMS.
 */
function writeRelease(
  sha256sums: string,
  assets: ReadonlyArray<string> = ["hercule-darwin-arm64", "Hercule-darwin-arm64.zip"],
): string {
  const dir = makeTemporaryDir("hercule-install-release-");
  for (const asset of assets) writeFileSync(join(dir, asset), `not ${asset}`);
  writeFileSync(join(dir, "SHA256SUMS"), sha256sums);
  return dir;
}

/** One time the fake binary ran: its HERCULE_HOME and its arguments. */
interface BinaryCall {
  readonly herculeHome: string;
  readonly args: string;
}

/**
 * Writes a release that install.sh accepts and installs: on macOS a zipped app
 * and binary, on Linux just the binary, plus a SHA256SUMS that matches. The
 * binary is a shell script that records every call. `hercule --version` prints
 * a version, and `hercule service ...` prints a line and exits with
 * `serviceExitCode`.
 *
 * Returns the release folder, and a function that reads the calls recorded so
 * far, in order.
 */
function writeInstallableRelease(serviceExitCode = 0): {
  readonly dir: string;
  readonly readBinaryCalls: () => ReadonlyArray<BinaryCall>;
} {
  const dir = makeTemporaryDir("hercule-install-release-");
  const callsFile = join(makeTemporaryDir("hercule-install-calls-"), "calls");

  // Detect platform and write the appropriate binary
  const isMacOS = process.platform === "darwin";
  const isLinux = process.platform === "linux";
  const binaryName = isMacOS
    ? "hercule-darwin-arm64"
    : isLinux && process.arch === "x64"
      ? "hercule-linux-x64"
      : isLinux && process.arch === "arm64"
        ? "hercule-linux-arm64"
        : "hercule-darwin-arm64"; // fallback for tests on unsupported platforms

  // Each call is one line: the HERCULE_HOME, a tab, then the arguments.
  writeFileSync(
    join(dir, binaryName),
    `#!/bin/sh
printf '%s\\t%s\\n' "\${HERCULE_HOME-}" "$*" >> '${callsFile}'
case $1 in
  --version) echo 0.0.0-test ;;
  service) echo "fake hercule service output"; exit ${serviceExitCode} ;;
esac
`,
  );

  const assets = [binaryName];

  // On macOS, also create the app
  if (isMacOS) {
    const appStage = makeTemporaryDir("hercule-install-app-");
    const macOSDir = join(appStage, "Hercule.app", "Contents", "MacOS");
    mkdirSync(macOSDir, { recursive: true });
    writeFileSync(join(macOSDir, "Hercule"), "#!/bin/sh\n");
    // The same command the `edge-build` job zips the app with.
    const zip = spawnSync("ditto", [
      "-c",
      "-k",
      "--keepParent",
      join(appStage, "Hercule.app"),
      join(dir, "Hercule-darwin-arm64.zip"),
    ]);
    expect(zip.status).toBe(0);
    assets.push("Hercule-darwin-arm64.zip");
  }

  const sha256sums = assets
    .map((asset) => {
      const hash = createHash("sha256")
        .update(readFileSync(join(dir, asset)))
        .digest("hex");
      return `${hash}  ${asset}\n`;
    })
    .join("");
  writeFileSync(join(dir, "SHA256SUMS"), sha256sums);

  const readBinaryCalls = (): ReadonlyArray<BinaryCall> =>
    existsSync(callsFile)
      ? readFileSync(callsFile, "utf8")
          .trimEnd()
          .split("\n")
          .map((line) => {
            const [herculeHome = "", args = ""] = line.split("\t");
            return { herculeHome, args };
          })
      : [];
  return { dir, readBinaryCalls };
}

const isAppleSilicon = process.platform === "darwin" && process.arch === "arm64";
const isLinuxX64 = process.platform === "linux" && process.arch === "x64";
const isLinuxArm64 = process.platform === "linux" && process.arch === "arm64";
const isLinux = isLinuxX64 || isLinuxArm64;

describe("install.sh", () => {
  it.runIf(isAppleSilicon)(
    "installs the binary and the app on a first install, and starts nothing",
    () => {
      const release = writeInstallableRelease();

      const { status, stdout, home, applicationsDir } = runInstall(release.dir, {
        buildHerculeHome: (home) => join(home, "scratch-home"),
      });

      expect(status).toBe(0);
      expect(existsSync(join(home, ".local", "bin", "hercule"))).toBe(true);
      expect(existsSync(join(applicationsDir, "Hercule.app", "Contents", "MacOS", "Hercule"))).toBe(
        true,
      );
      // No unit is written and none is installed: the binary only printed
      // its version.
      expect(release.readBinaryCalls().map((call) => call.args)).toEqual(["--version"]);
      expect(existsSync(join(home, "Library"))).toBe(false);
      // The next steps carry the Home this run was given, and the binary's
      // full path, because its folder is not on PATH. Both are quoted, so a
      // path with a space pastes as one word.
      expect(stdout).toContain("Nothing is running yet");
      expect(stdout).toContain(
        `HERCULE_HOME='${join(home, "scratch-home")}' '${join(home, ".local", "bin", "hercule")}' service install\n`,
      );
      expect(stdout).toContain('"Add machine"');
      // The app uses only the default Home, so it is no next step for this one.
      expect(stdout).not.toContain("Applications folder");
    },
  );

  it.runIf(isAppleSilicon)(
    "names the app first on a first install with the default Home, then the commands",
    () => {
      const release = writeInstallableRelease();

      const { status, stdout, home } = runInstall(release.dir);

      expect(status).toBe(0);
      const hercule = `'${join(home, ".local", "bin", "hercule")}'`;
      const app = stdout.indexOf(
        "Nothing is running yet. To set up Hercule, open Hercule in your Applications folder.\n",
      );
      const commands = stdout.indexOf(
        `To run Hercule on this Mac without the app, start it as a service, then open the setup page in your browser; the second command prints its address:\n\n  ${hercule} service install\n  ${hercule} setup-url\n`,
      );
      expect(app).toBeGreaterThan(-1);
      expect(commands).toBeGreaterThan(app);
      expect(stdout.indexOf('"Add machine"')).toBeGreaterThan(commands);
      // The default Home needs no HERCULE_HOME in the commands.
      expect(stdout).not.toContain("HERCULE_HOME=");
    },
  );

  it.runIf(isAppleSilicon)(
    "updates the installed service with `hercule service install` and the Home it names",
    () => {
      const release = writeInstallableRelease();

      const { status, stdout } = runInstall(release.dir, {
        buildHerculeHome: () => undefined,
        launchAgent: buildLaunchAgent({ HERCULE_HOME: "/Users/someone/other-home" }),
      });

      expect(status).toBe(0);
      expect(release.readBinaryCalls()).toEqual([
        { herculeHome: "/Users/someone/other-home", args: "service install" },
        { herculeHome: "", args: "--version" },
      ]);
      expect(stdout).toContain("fake hercule service output");
      expect(stdout).not.toContain("Nothing is running yet");
    },
  );

  it.runIf(isAppleSilicon)("fails when `hercule service install` fails on an update", () => {
    const release = writeInstallableRelease(1);

    const { status, stdout, stderr } = runInstall(release.dir, {
      launchAgent: buildLaunchAgent({ PATH: "/usr/bin:/bin" }),
    });

    expect(status).toBe(1);
    // The service's own output stays visible: it explains what went wrong.
    expect(stdout).toContain("fake hercule service output");
    expect(stderr).toContain("the binary and the app are updated, but the service was not");
  });

  it.runIf(isAppleSilicon)(
    "refuses a download that does not match SHA256SUMS, and installs nothing",
    () => {
      const wrongSha256 = "0".repeat(64);
      const release = writeRelease(
        `${wrongSha256}  hercule-darwin-arm64\n${wrongSha256}  Hercule-darwin-arm64.zip\n`,
      );

      const { status, stderr, home, applicationsDir } = runInstall(release);

      expect(status).toBe(1);
      expect(stderr).toContain("does not match SHA256SUMS, so nothing was installed");
      // The throwaway folders are left as they were created: no binary, no
      // app, no LaunchAgent, no Hercule Home.
      expect(readdirSync(home)).toEqual([]);
      expect(readdirSync(applicationsDir)).toEqual([]);
    },
  );

  it.runIf(isAppleSilicon)("refuses a release with a missing file, and installs nothing", () => {
    const release = writeRelease("", ["hercule-darwin-arm64"]);

    const { status, stderr, home } = runInstall(release);

    expect(status).toBe(1);
    expect(stderr).toContain("could not download Hercule-darwin-arm64.zip");
    expect(readdirSync(home)).toEqual([]);
  });

  it.runIf(isAppleSilicon)(
    "refuses a SHA256SUMS that leaves a file out, and installs nothing",
    () => {
      const release = writeRelease(`${"0".repeat(64)}  hercule-darwin-arm64\n`);

      const { status, stderr, home } = runInstall(release);

      expect(status).toBe(1);
      expect(stderr).toContain("SHA256SUMS does not list Hercule-darwin-arm64.zip");
      expect(readdirSync(home)).toEqual([]);
    },
  );

  it.runIf(isAppleSilicon)(
    "refuses a HERCULE_HOME other than the one the installed service uses",
    () => {
      const { status, stderr } = runInstall(writeRelease(""), {
        launchAgent: buildLaunchAgent({ HERCULE_HOME: "/Users/someone/other-home" }),
      });

      expect(status).toBe(1);
      expect(stderr).toContain(
        "the installed service uses the Hercule Home /Users/someone/other-home",
      );
    },
  );

  it.runIf(isAppleSilicon)("accepts any HERCULE_HOME when the installed service names none", () => {
    const { status, stderr } = runInstall(writeRelease("", []), {
      launchAgent: buildLaunchAgent({ PATH: "/usr/bin:/bin" }),
    });

    // The run gets past the Hercule Home checks to the download, which
    // fails because the release is empty.
    expect(status).toBe(1);
    expect(stderr).toContain("could not download hercule-darwin-arm64");
  });

  it.runIf(isAppleSilicon)("refuses a relative HERCULE_HOME", () => {
    const { status, stderr, home } = runInstall(writeRelease(""), {
      buildHerculeHome: () => "hercule-home",
    });

    expect(status).toBe(1);
    expect(stderr).toContain("HERCULE_HOME is hercule-home, which is not an absolute path");
    expect(readdirSync(home)).toEqual([]);
  });

  it.runIf(isLinux)(
    "installs the binary on a first install on Linux, and starts nothing",
    () => {
      const release = writeInstallableRelease();

      const { status, stdout, home, applicationsDir } = runInstall(release.dir, {
        buildHerculeHome: (home) => join(home, "scratch-home"),
      });

      expect(status).toBe(0);
      expect(existsSync(join(home, ".local", "bin", "hercule"))).toBe(true);
      // No app is installed on Linux.
      expect(readdirSync(applicationsDir)).toEqual([]);
      // No unit is written and none is installed: the binary only printed
      // its version.
      expect(release.readBinaryCalls().map((call) => call.args)).toEqual(["--version"]);
      expect(existsSync(join(home, ".config"))).toBe(false);
      // The next steps carry the Home this run was given, and the binary's
      // full path, because its folder is not on PATH. Both are quoted, so a
      // path with a space pastes as one word.
      expect(stdout).toContain("Nothing is running yet");
      expect(stdout).toContain(
        `HERCULE_HOME='${join(home, "scratch-home")}' '${join(home, ".local", "bin", "hercule")}' service install\n`,
      );
      expect(stdout).toContain('"Add machine"');
      // The app is never named on Linux.
      expect(stdout).not.toContain("Applications folder");
    },
  );

  it.runIf(isLinux)(
    "updates the installed service with `hercule service install` and the Home it names on Linux",
    () => {
      const release = writeInstallableRelease();

      const { status, stdout } = runInstall(release.dir, {
        buildHerculeHome: () => undefined,
        systemdUnit: buildSystemdUnit({ HERCULE_HOME: "/home/someone/other-home" }),
      });

      expect(status).toBe(0);
      expect(release.readBinaryCalls()).toEqual([
        { herculeHome: "/home/someone/other-home", args: "service install" },
        { herculeHome: "", args: "--version" },
      ]);
      expect(stdout).toContain("fake hercule service output");
      expect(stdout).not.toContain("Nothing is running yet");
    },
  );

  it.runIf(isLinux)("fails when `hercule service install` fails on an update on Linux", () => {
    const release = writeInstallableRelease(1);

    const { status, stdout, stderr } = runInstall(release.dir, {
      systemdUnit: buildSystemdUnit({ PATH: "/usr/bin:/bin" }),
    });

    expect(status).toBe(1);
    // The service's own output stays visible: it explains what went wrong.
    expect(stdout).toContain("fake hercule service output");
    expect(stderr).toContain("the binary is updated, but the service was not");
  });

  it.runIf(process.platform !== "darwin" && process.platform !== "linux")(
    "refuses to run on unsupported platforms",
    () => {
      const { status, stderr } = runInstall(writeRelease(""));

      expect(status).toBe(1);
      expect(stderr).toContain("the edge build runs on macOS on Apple silicon and on Linux");
    },
  );
});
