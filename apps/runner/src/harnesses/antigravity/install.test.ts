/**
 * Tests installing Antigravity. The real install script runs under bash in a
 * throwaway home, with stub `uname`, `ldd` and `curl` programs first in the
 * PATH, so nothing is downloaded and nothing outside the temporary folders is
 * touched. The stub `curl` serves an archive the test makes. Because the
 * pinned checksums cannot match that archive, most tests install through
 * the installer's `checksums` parameter with the archive's own digest.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
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

const ASSETS = [
  "agy_cli_mac_arm64",
  "agy_cli_mac_x64",
  "agy_cli_linux_x64",
  "agy_cli_linux_x64_musl",
  "agy_cli_linux_arm64",
  "agy_cli_linux_arm64_musl",
];

// The script decides on musl from these files too, so a host that has them
// would give the glibc cases a different answer than the stub `ldd`.
const HOST_USES_MUSL =
  existsSync("/lib/libc.musl-x86_64.so.1") || existsSync("/lib/libc.musl-aarch64.so.1");

const PLATFORM_GROUPS: ReadonlyArray<{
  readonly name: string;
  readonly libc: "glibc" | "musl";
  readonly skip: boolean;
  readonly rows: Array<[kernel: string, machine: string, asset: string]>;
}> = [
  {
    name: "Darwin",
    libc: "glibc",
    skip: false,
    rows: [
      ["Darwin", "arm64", "agy_cli_mac_arm64"],
      ["Darwin", "x86_64", "agy_cli_mac_x64"],
    ],
  },
  {
    name: "Linux with glibc",
    libc: "glibc",
    skip: HOST_USES_MUSL,
    rows: [
      ["Linux", "x86_64", "agy_cli_linux_x64"],
      ["Linux", "amd64", "agy_cli_linux_x64"],
      ["Linux", "aarch64", "agy_cli_linux_arm64"],
      ["Linux", "arm64", "agy_cli_linux_arm64"],
    ],
  },
  {
    name: "Linux with musl",
    libc: "musl",
    skip: false,
    rows: [
      ["Linux", "x86_64", "agy_cli_linux_x64_musl"],
      ["Linux", "aarch64", "agy_cli_linux_arm64_musl"],
    ],
  },
];

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
  // Records every argument and the URL asked for, then copies the fixture
  // archive to the file named by `-o`, or fails like `curl -f` does on an
  // HTTP error.
  writeStub(
    "curl",
    [
      `printf '%s\\n' "$@" >> "${stubs}/curl-arguments"`,
      `out=""; url=""`,
      `while [ $# -gt 0 ]; do`,
      `  case "$1" in`,
      `    -o) out="$2"; shift 2 ;;`,
      `    --proto | --proto-redir | --connect-timeout | --max-time) shift 2 ;;`,
      `    -*) shift ;;`,
      `    *) url="$1"; shift ;;`,
      `  esac`,
      `done`,
      `echo "$url" >> "${stubs}/urls"`,
      `if [ -e "${stubs}/curl-fails" ]; then exit 22; fi`,
      `cp "${stubs}/archive.tar.gz" "$out"`,
    ].join("\n"),
  );
  // Darwin never looks at the C library, so it is the default system.
  setSystem("Darwin", "arm64");
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

/** Makes the archive that the stub `curl` serves, holding one entry named `antigravity` made by `prepare`. */
function packArchive(entryName: string, prepare: (path: string) => void): void {
  const source = join(root, "archive-source");
  rmSync(source, { recursive: true, force: true });
  mkdirSync(source);
  prepare(join(source, entryName));
  Bun.spawnSync(["tar", "-czf", join(stubs, "archive.tar.gz"), "-C", source, entryName]);
}

/** Serves an archive holding a regular file with the given name. */
function makeArchive(fileName: string): void {
  packArchive(fileName, (path) => writeFileSync(path, NEW_AGY));
}

function installOldAgy(): void {
  mkdirSync(bin(), { recursive: true });
  writeFileSync(join(bin(), "agy"), OLD_AGY, { mode: 0o755 });
}

/** Returns a table that pins the archive the stub `curl` serves for every asset. */
const checksumsOfServedArchive = (): Record<string, string> => {
  const digest = createHash("sha256")
    .update(readFileSync(join(stubs, "archive.tar.gz")))
    .digest("hex");
  return Object.fromEntries(ASSETS.map((asset) => [asset, digest]));
};

const environment = () => ({ HOME: home, PATH: `${stubs}:/usr/bin:/bin` });

/** Runs the installer's real script with an environment built from nothing. */
const install = (checksums: Readonly<Record<string, string>> = checksumsOfServedArchive()) =>
  Effect.runPromise(makeAntigravityInstall(runProcess, checksums)(environment()));

const readLines = (name: string): ReadonlyArray<string> => {
  const file = join(stubs, name);
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];
};

const assetUrl = (asset: string): string =>
  `https://github.com/google-antigravity/antigravity-cli/releases/download/${ANTIGRAVITY_VERSION}/${asset}.tar.gz`;

describe("installing Antigravity", () => {
  for (const group of PLATFORM_GROUPS) {
    describe.skipIf(group.skip)(group.name, () => {
      beforeEach(() => {
        setLibc(group.libc);
      });

      it.each(group.rows)(
        "downloads the right release asset on %s %s",
        async (kernel, machine, asset) => {
          setSystem(kernel, machine);

          const outcome = await install();

          expect(outcome).toEqual({ ok: true });
          expect(readLines("urls")).toEqual([assetUrl(asset)]);
        },
      );

      // The pinned table has no digest for an archive made by a test, so a
      // pinned asset fails with the mismatch and an asset missing from the
      // table fails with a different message.
      it.each(group.rows)("pins a checksum for the asset on %s %s", async (kernel, machine) => {
        setSystem(kernel, machine);

        const outcome = await Effect.runPromise(makeAntigravityInstall(runProcess)(environment()));

        expect(outcome.ok).toBe(false);
        expect(outcome.message).toContain("is not the one this Hercule build was made for");
      });
    });
  }

  it("downloads over https only, and gives up on a stalled connection", async () => {
    await install();

    const argumentsOfCurl = readLines("curl-arguments");
    expect(argumentsOfCurl).toEqual(
      expect.arrayContaining([
        "--proto",
        "--proto-redir",
        "=https",
        "--connect-timeout",
        "30",
        "--max-time",
        "240",
      ]),
    );
  });

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

  describe("when it fails", () => {
    const expectOldAgyKept = () => {
      expect(readdirSync(bin())).toEqual(["agy"]);
      expect(readFileSync(join(bin(), "agy"), "utf8")).toBe(OLD_AGY);
    };

    beforeEach(() => {
      installOldAgy();
    });

    it("keeps the existing agy and leaves no staging folder when the download fails", async () => {
      writeFileSync(join(stubs, "curl-fails"), "");

      const outcome = await install();

      expect(outcome.ok).toBe(false);
      expectOldAgyKept();
    });

    it("keeps the existing agy when the download is not the one this build was made for", async () => {
      const outcome = await install({ agy_cli_mac_arm64: "0".repeat(64) });

      expect(outcome.ok).toBe(false);
      expect(outcome.message).toContain("is not the one this Hercule build was made for");
      expectOldAgyKept();
    });

    it("keeps the existing agy when the archive lacks antigravity", async () => {
      makeArchive("something-else");

      const outcome = await install();

      expect(outcome.ok).toBe(false);
      expectOldAgyKept();
    });

    it("keeps the existing agy when antigravity in the archive is a link", async () => {
      packArchive("antigravity", (path) => symlinkSync("/nonexistent-target", path));

      const outcome = await install();

      expect(outcome.ok).toBe(false);
      expect(outcome.message).toContain("not a regular file");
      expectOldAgyKept();
    });
  });

  describe("when ~/.local/bin/agy is a folder", () => {
    it.each(["a folder", "a link to a folder"])(
      "refuses and moves nothing into it when it is %s",
      async (kind) => {
        const target = join(root, "target-folder");
        mkdirSync(target);
        mkdirSync(bin(), { recursive: true });
        if (kind === "a folder") {
          rmSync(target, { recursive: true });
          mkdirSync(join(bin(), "agy"));
        } else {
          symlinkSync(target, join(bin(), "agy"));
        }

        const outcome = await install();

        expect(outcome.ok).toBe(false);
        expect(outcome.message).toContain("folder");
        expect(readdirSync(bin())).toEqual(["agy"]);
        expect(readdirSync(kind === "a folder" ? join(bin(), "agy") : target)).toEqual([]);
      },
    );
  });

  it.each([
    ["FreeBSD", "x86_64"],
    ["Linux", "i686"],
  ])("refuses %s %s and names the system", async (kernel, machine) => {
    setSystem(kernel, machine);

    const outcome = await install();

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain(`${kernel} ${machine}`);
    expect(readLines("urls")).toEqual([]);
    expect(existsSync(join(bin(), "agy"))).toBe(false);
  });
});
