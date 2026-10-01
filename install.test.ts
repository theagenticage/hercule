import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";

const script = fileURLToPath(new URL("install.sh", import.meta.url));

const launchAgentPath = join("Library", "LaunchAgents", "sh.hercule.service.plist");

/** How install.sh is set up: its HERCULE_HOME, and any installed LaunchAgent. */
interface InstallSetup {
  /**
   * Returns the HERCULE_HOME install.sh runs with, given the home folder, or
   * undefined to leave it unset. By default it is `<home>/.hercule`.
   */
  readonly buildHerculeHome?: (home: string) => string | undefined;
  /** The content of an installed LaunchAgent's plist, if there is one. */
  readonly launchAgent?: string;
}

/**
 * Runs install.sh with a throwaway home folder and the release read from
 * `releaseDir`. Returns its exit code, its error output, and the path of the
 * home folder, which is deleted when the test finishes.
 */
function runInstall(
  releaseDir: string,
  setup: InstallSetup = {},
): { status: number | null; stderr: string; home: string } {
  const home = mkdtempSync(join(tmpdir(), "hercule-install-home-"));
  onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  if (setup.launchAgent !== undefined) {
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(join(home, launchAgentPath), setup.launchAgent);
  }
  const herculeHome = (setup.buildHerculeHome ?? ((home) => join(home, ".hercule")))(home);
  const result = spawnSync("sh", [script], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: home,
      ...(herculeHome === undefined ? {} : { HERCULE_HOME: herculeHome }),
      HERCULE_RELEASE_URL: pathToFileURL(releaseDir).href,
    },
  });
  return { status: result.status, stderr: result.stderr, home };
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
 * Writes a release folder holding fake assets and a SHA256SUMS whose content is
 * `sha256sums`, and returns its path. `assets` names the files written beside
 * SHA256SUMS.
 */
function writeRelease(
  sha256sums: string,
  assets: ReadonlyArray<string> = ["hercule-darwin-arm64", "Hercule-darwin-arm64.zip"],
): string {
  const dir = mkdtempSync(join(tmpdir(), "hercule-install-release-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  for (const asset of assets) writeFileSync(join(dir, asset), `not ${asset}`);
  writeFileSync(join(dir, "SHA256SUMS"), sha256sums);
  return dir;
}

const isAppleSilicon = process.platform === "darwin" && process.arch === "arm64";

describe("install.sh", () => {
  it.runIf(isAppleSilicon)(
    "refuses a download that does not match SHA256SUMS, and installs nothing",
    () => {
      const wrongSha256 = "0".repeat(64);
      const release = writeRelease(
        `${wrongSha256}  hercule-darwin-arm64\n${wrongSha256}  Hercule-darwin-arm64.zip\n`,
      );

      const { status, stderr, home } = runInstall(release);

      expect(status).toBe(1);
      expect(stderr).toContain("does not match SHA256SUMS, so nothing was installed");
      // The throwaway home is left as it was created: no binary, no
      // LaunchAgent, no Hercule Home.
      expect(readdirSync(home)).toEqual([]);
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
    "refuses a HERCULE_HOME other than the one the installed controller uses",
    () => {
      const { status, stderr } = runInstall(writeRelease(""), {
        launchAgent: buildLaunchAgent({ HERCULE_HOME: "/Users/someone/other-home" }),
      });

      expect(status).toBe(1);
      expect(stderr).toContain("the controller uses the Hercule Home /Users/someone/other-home");
    },
  );

  it.runIf(isAppleSilicon)(
    "accepts any HERCULE_HOME when the installed controller names none",
    () => {
      const { status, stderr } = runInstall(writeRelease("", []), {
        launchAgent: buildLaunchAgent({ PATH: "/usr/bin:/bin" }),
      });

      // The run gets past the Hercule Home checks to the download, which
      // fails because the release is empty.
      expect(status).toBe(1);
      expect(stderr).toContain("could not download hercule-darwin-arm64");
    },
  );

  it.runIf(isAppleSilicon)(
    "accepts an unset HERCULE_HOME when the installed controller names a Hercule Home",
    () => {
      const { status, stderr } = runInstall(writeRelease("", []), {
        buildHerculeHome: () => undefined,
        launchAgent: buildLaunchAgent({ HERCULE_HOME: "/Users/someone/other-home" }),
      });

      // The run gets past the Hercule Home checks to the download, which
      // fails because the release is empty.
      expect(status).toBe(1);
      expect(stderr).toContain("could not download hercule-darwin-arm64");
    },
  );

  it.runIf(isAppleSilicon)("refuses a relative HERCULE_HOME", () => {
    const { status, stderr, home } = runInstall(writeRelease(""), {
      buildHerculeHome: () => "hercule-home",
    });

    expect(status).toBe(1);
    expect(stderr).toContain("HERCULE_HOME is hercule-home, which is not an absolute path");
    expect(readdirSync(home)).toEqual([]);
  });

  it.runIf(process.platform !== "darwin")("refuses to run anywhere but macOS", () => {
    const { status, stderr } = runInstall(writeRelease(""));

    expect(status).toBe(1);
    expect(stderr).toContain("runs on macOS on Apple silicon only");
  });
});
