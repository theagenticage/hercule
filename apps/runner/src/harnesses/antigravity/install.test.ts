/**
 * Tests installing Antigravity. The real install script runs under bash in a
 * throwaway home, with stub `uname` and `curl` programs first in the PATH, so
 * nothing is downloaded and nothing outside the temporary folders is touched.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { ANTIGRAVITY_VERSION } from "@hercule/home/version";
import { runProcess } from "../process";
import { makeAntigravityInstall } from "./install";

const NEW_AGY = "#!/bin/sh\necho new agy\n";
const OLD_AGY = "#!/bin/sh\necho old agy\n";

let root: string;
let home: string;
let stubs: string;

const bin = (): string => join(home, ".local", "bin");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hercule-antigravity-install-"));
  home = join(root, "home");
  stubs = join(root, "stubs");
  mkdirSync(home);
  mkdirSync(stubs);
  writeStub(
    "uname",
    `case "$1" in -s) cat "${stubs}/uname-s" ;; -m) cat "${stubs}/uname-m" ;; esac`,
  );
  // Records every URL asked for, then copies the fixture archive to the file
  // named by `-o`, or fails like `curl -f` does on an HTTP error.
  writeStub(
    "curl",
    [
      `out=""; url=""`,
      `while [ $# -gt 0 ]; do`,
      `  case "$1" in -o) out="$2"; shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac`,
      `done`,
      `echo "$url" >> "${stubs}/urls"`,
      `if [ -e "${stubs}/curl-fails" ]; then exit 22; fi`,
      `cp "${stubs}/archive.tar.gz" "$out"`,
    ].join("\n"),
  );
  setSystem("Linux", "x86_64");
  setLibc("glibc");
  makeArchive("antigravity");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeStub(name: string, body: string): void {
  const file = join(stubs, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

function setSystem(kernel: string, machine: string): void {
  writeFileSync(join(stubs, "uname-s"), kernel);
  writeFileSync(join(stubs, "uname-m"), machine);
}

/** Makes the stub `ldd` print what `ldd` prints on a system with the given C library. */
function setLibc(libc: "glibc" | "musl"): void {
  writeStub(
    "ldd",
    libc === "musl"
      ? `echo "	/lib/ld-musl-x86_64.so.1 (0x7f0000000000)"`
      : `echo "	linux-vdso.so.1 (0x00007ffd0000)"; echo "	libc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f00)"`,
  );
}

/** Makes the archive that the stub `curl` serves, holding one file with the given name. */
function makeArchive(fileName: string): void {
  const source = join(root, "archive-source");
  rmSync(source, { recursive: true, force: true });
  mkdirSync(source);
  writeFileSync(join(source, fileName), NEW_AGY);
  Bun.spawnSync(["tar", "-czf", join(stubs, "archive.tar.gz"), "-C", source, fileName]);
}

function installOldAgy(): void {
  mkdirSync(bin(), { recursive: true });
  writeFileSync(join(bin(), "agy"), OLD_AGY, { mode: 0o755 });
}

/** Runs the installer's real script with an environment built from nothing. */
const install = () =>
  Effect.runPromise(
    makeAntigravityInstall(runProcess)({ HOME: home, PATH: `${stubs}:/usr/bin:/bin` }),
  );

const urlsAskedFor = (): ReadonlyArray<string> => {
  const file = join(stubs, "urls");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];
};

const assetUrl = (asset: string): string =>
  `https://github.com/google-antigravity/antigravity-cli/releases/download/${ANTIGRAVITY_VERSION}/${asset}.tar.gz`;

describe("installing Antigravity", () => {
  it("names the release this build pins", async () => {
    const commands: Array<ReadonlyArray<string>> = [];
    await Effect.runPromise(
      makeAntigravityInstall((command) =>
        Effect.sync(() => {
          commands.push(command);
          return { code: 0, stdout: "", stderr: "" };
        }),
      )({}),
    );

    expect(commands).toHaveLength(1);
    expect(commands[0]!.join(" ")).toContain(ANTIGRAVITY_VERSION);
  });

  it.each([
    ["Darwin", "arm64", "agy_cli_mac_arm64"],
    ["Darwin", "x86_64", "agy_cli_mac_x64"],
    ["Linux", "x86_64", "agy_cli_linux_x64"],
    ["Linux", "amd64", "agy_cli_linux_x64"],
    ["Linux", "aarch64", "agy_cli_linux_arm64"],
    ["Linux", "arm64", "agy_cli_linux_arm64"],
  ])("downloads the right release asset on %s %s", async (kernel, machine, asset) => {
    setSystem(kernel, machine);

    const outcome = await install();

    expect(outcome).toEqual({ ok: true });
    expect(urlsAskedFor()).toEqual([assetUrl(asset)]);
  });

  it.each([
    ["x86_64", "agy_cli_linux_x64_musl"],
    ["aarch64", "agy_cli_linux_arm64_musl"],
  ])(
    "downloads the musl release asset on Linux %s with the musl C library",
    async (machine, asset) => {
      setSystem("Linux", machine);
      setLibc("musl");

      const outcome = await install();

      expect(outcome).toEqual({ ok: true });
      expect(urlsAskedFor()).toEqual([assetUrl(asset)]);
    },
  );

  it("installs an executable agy and leaves nothing else in the folder", async () => {
    installOldAgy();

    const outcome = await install();

    expect(outcome).toEqual({ ok: true });
    expect(readdirSync(bin())).toEqual(["agy"]);
    expect(readFileSync(join(bin(), "agy"), "utf8")).toBe(NEW_AGY);
    expect(statSync(join(bin(), "agy")).mode & 0o777).toBe(0o755);
  });

  it("creates ~/.local/bin when it does not exist", async () => {
    const outcome = await install();

    expect(outcome).toEqual({ ok: true });
    expect(readFileSync(join(bin(), "agy"), "utf8")).toBe(NEW_AGY);
  });

  it("keeps the existing agy and leaves no staging folder when the download fails", async () => {
    installOldAgy();
    writeFileSync(join(stubs, "curl-fails"), "");

    const outcome = await install();

    expect(outcome.ok).toBe(false);
    expect(readdirSync(bin())).toEqual(["agy"]);
    expect(readFileSync(join(bin(), "agy"), "utf8")).toBe(OLD_AGY);
  });

  it("keeps the existing agy and leaves no staging folder when the archive lacks antigravity", async () => {
    installOldAgy();
    makeArchive("something-else");

    const outcome = await install();

    expect(outcome.ok).toBe(false);
    expect(readdirSync(bin())).toEqual(["agy"]);
    expect(readFileSync(join(bin(), "agy"), "utf8")).toBe(OLD_AGY);
  });

  it.each([
    ["FreeBSD", "x86_64"],
    ["Linux", "i686"],
  ])("refuses %s %s and names the system", async (kernel, machine) => {
    setSystem(kernel, machine);

    const outcome = await install();

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain(`${kernel} ${machine}`);
    expect(urlsAskedFor()).toEqual([]);
    expect(existsSync(join(bin(), "agy"))).toBe(false);
  });
});
