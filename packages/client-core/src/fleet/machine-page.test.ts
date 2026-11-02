import { describe, expect, it } from "vitest";
import type { Harness, Runner, Session } from "@hercule/contract";
import {
  ANTHROPIC_IDENTITY,
  BARE,
  HARNESSES,
  OPENAI_IDENTITY,
  PROVIDERS,
  WITH_CLAUDE,
  ZAI_IDENTITY,
  buildProviderAccount,
  buildSnapshot,
} from "../providers.testing";
import {
  changeRunnerLabels,
  countOpenThreads,
  describeOfflineBanner,
  formatDiskLimit,
  isRunnerBehind,
  listMachineAccounts,
  listMachineHarnesses,
  parseDiskLimit,
  parseSessionCap,
  validateRunnerLabel,
} from "./machine-page";

const GIB = 1024 ** 3;
const TIMEZONE = "UTC";
const NOW = new Date("2026-11-02T14:00:00.000Z");

describe("isRunnerBehind", () => {
  it("is true when the controller's release is newer in any of the three numbers", () => {
    expect(isRunnerBehind("0.9.3", "0.9.4")).toBe(true);
    expect(isRunnerBehind("0.9.3", "0.10.0")).toBe(true);
    expect(isRunnerBehind("0.9.3", "1.0.0")).toBe(true);
  });

  it("compares numbers, not text, so 0.9.3 is behind 0.10.0", () => {
    expect(isRunnerBehind("0.9.3", "0.10.0")).toBe(true);
    expect(isRunnerBehind("0.10.0", "0.9.3")).toBe(false);
  });

  it("is false when the runner is on the same release or a newer one", () => {
    expect(isRunnerBehind("0.9.3", "0.9.3")).toBe(false);
    expect(isRunnerBehind("0.9.4", "0.9.3")).toBe(false);
  });

  it("ignores build metadata, so two builds of one release are not behind", () => {
    expect(isRunnerBehind("0.1.0+aaaaaaaaa", "0.1.0+bbbbbbbbb")).toBe(false);
    expect(isRunnerBehind("0.1.0+aaaaaaaaa", "0.1.1+bbbbbbbbb")).toBe(true);
  });

  it("is false when a version is missing or has no known order", () => {
    expect(isRunnerBehind(null, "0.9.3")).toBe(false);
    expect(isRunnerBehind("0.9.3-rc.1", "0.9.3")).toBe(false);
    expect(isRunnerBehind("0.9.2", "edge")).toBe(false);
  });
});

describe("countOpenThreads", () => {
  const session = (runnerId: string, kind: Session["kind"], status: Session["status"]) =>
    ({ runnerId, kind, status }) as Session;

  it("counts the threads on the runner that have not exited", () => {
    expect(
      countOpenThreads(
        [
          session("a", "thread", "queued"),
          session("a", "thread", "busy"),
          session("a", "thread", "exited"),
          session("a", "agent", "busy"),
          session("b", "thread", "busy"),
        ],
        "a",
      ),
    ).toBe(2);
  });
});

describe("describeOfflineBanner", () => {
  const runner = (overrides: Partial<Runner> = {}): Runner => ({
    ...BARE,
    name: "atlas",
    connectivity: "offline",
    lastSeenAt: "2026-11-02T09:12:00.000Z",
    ...overrides,
  });
  const join = (banner: ReturnType<typeof describeOfflineBanner>) =>
    `${banner.headline} ${banner.before}${banner.command}${banner.after}`;

  it("words the spec's banner, with the time the runner was last heard from", () => {
    expect(join(describeOfflineBanner(runner(), 3, TIMEZONE, NOW))).toBe(
      "atlas has not been heard from since 09:12. It may be asleep, off the network, or without power. Its 3 threads can carry on once it is back, and work waiting for it starts then. If it does not come back by itself, start Hercule on it again: hercule service start. What you see below is from 09:12.",
    );
  });

  it("names the command to draw as code", () => {
    expect(describeOfflineBanner(runner(), 3, TIMEZONE, NOW).command).toBe("hercule service start");
  });

  it("says 1 thread in the singular", () => {
    expect(join(describeOfflineBanner(runner(), 1, TIMEZONE, NOW))).toContain(
      "Its 1 thread can carry on",
    );
  });

  it("leaves the sentence about threads out at 0", () => {
    const text = join(describeOfflineBanner(runner(), 0, TIMEZONE, NOW));

    expect(text).not.toContain("thread");
    expect(text).toContain("without power. If it does not come back by itself");
  });

  it("words a runner that was never heard from without a time", () => {
    expect(join(describeOfflineBanner(runner({ lastSeenAt: null }), 0, TIMEZONE, NOW))).toBe(
      "atlas has not been heard from. It may be asleep, off the network, or without power. If it does not come back by itself, start Hercule on it again: hercule service start.",
    );
  });
});

describe("listMachineHarnesses", () => {
  const withRunners = (runners: Harness["runners"]): Harness[] => [
    { ...HARNESSES[0]!, runners },
    { ...HARNESSES[1]!, runners: [] },
  ];
  const entry = (overrides: Partial<Harness["runners"][number]>): Harness["runners"][number] => ({
    runnerId: BARE.id,
    installed: true,
    version: "2.1.0",
    versionVerdict: "ok",
    ...overrides,
  });

  it("lists every harness, with the version this machine reported", () => {
    const rows = listMachineHarnesses(withRunners([entry({})]), BARE.id);

    expect(
      rows.map(({ name, versionText, isInstalled }) => [name, versionText, isInstalled]),
    ).toEqual([
      ["Claude Code", "2.1.0", true],
      ["Codex", "Not installed", false],
    ]);
  });

  it("says Installed when the machine has the harness but reported no version", () => {
    const [row] = listMachineHarnesses(withRunners([entry({ version: null })]), BARE.id);

    expect(row?.versionText).toBe("Installed");
  });

  it("reads only this machine's entry", () => {
    const [row] = listMachineHarnesses(
      withRunners([entry({ runnerId: "other", version: "9.9.9" })]),
      BARE.id,
    );

    expect(row).toMatchObject({ isInstalled: false, versionText: "Not installed" });
  });

  it("gives a version below the floor a failing note, and a version above the tested one a muted note", () => {
    const below = listMachineHarnesses(
      withRunners([entry({ versionVerdict: "below-floor" })]),
      BARE.id,
    )[0];
    const above = listMachineHarnesses(
      withRunners([entry({ versionVerdict: "above-tested-max" })]),
      BARE.id,
    )[0];

    expect(below?.note).toEqual({ text: "Too old for this Hercule: update it", tone: "fail" });
    expect(above?.note).toEqual({
      text: "Newer than this Hercule was tested with",
      tone: "muted",
    });
  });

  it("gives an ok or unknown verdict no note, and an uninstalled harness none at all", () => {
    const ok = listMachineHarnesses(withRunners([entry({})]), BARE.id)[0];
    const unknown = listMachineHarnesses(
      withRunners([entry({ versionVerdict: "unknown" })]),
      BARE.id,
    )[0];
    const missing = listMachineHarnesses(
      withRunners([entry({ installed: false, version: null, versionVerdict: "below-floor" })]),
      BARE.id,
    )[0];

    expect([ok?.note, unknown?.note, missing?.note]).toEqual([null, null, null]);
  });
});

describe("listMachineAccounts", () => {
  const list = (runner: Runner, accounts: ReturnType<typeof buildProviderAccount>[]) =>
    listMachineAccounts(runner, accounts, PROVIDERS, HARNESSES);

  it("offers Sign in on an online machine where the account is not signed in", () => {
    const [row] = list(WITH_CLAUDE, [buildProviderAccount(ANTHROPIC_IDENTITY)]);

    expect(row).toMatchObject({
      name: "Anthropic",
      harnessName: "Claude Code",
      text: "Not signed in",
      tone: "you",
      canSignIn: true,
    });
  });

  it("says who is signed in, and offers nothing", () => {
    const [row] = list(WITH_CLAUDE, [
      buildProviderAccount(
        ANTHROPIC_IDENTITY,
        [buildSnapshot({ runnerId: WITH_CLAUDE.id })],
        [{ runnerId: WITH_CLAUDE.id }],
      ),
    ]);

    expect(row).toMatchObject({
      text: "Signed in as rogier@example.com",
      tone: "muted",
      canSignIn: false,
    });
  });

  it("says that the machine needs the harness, with no way to install it", () => {
    const [row] = list(BARE, [buildProviderAccount(ANTHROPIC_IDENTITY)]);

    expect(row).toMatchObject({
      text: "Needs Claude Code on this machine",
      tone: "faint",
      canSignIn: false,
    });
  });

  it("gives the reason of a machine whose build cannot run the harness", () => {
    const runner = { ...WITH_CLAUDE, facts: { ...WITH_CLAUDE.facts!, adapters: [] } };

    const [row] = list(runner, [buildProviderAccount(ANTHROPIC_IDENTITY)]);

    expect(row).toMatchObject({
      text: "moss runs a Hercule build that cannot run Claude Code.",
      canSignIn: false,
    });
  });

  it("offers no Sign in on an offline machine", () => {
    const [row] = list({ ...WITH_CLAUDE, connectivity: "offline" }, [
      buildProviderAccount(ANTHROPIC_IDENTITY),
    ]);

    expect(row).toMatchObject({ text: "Not signed in", tone: "faint", canSignIn: false });
  });

  it("leaves out the accounts that work on every machine, and keeps the order of the rest", () => {
    const rows = list(WITH_CLAUDE, [
      buildProviderAccount(OPENAI_IDENTITY),
      buildProviderAccount(ZAI_IDENTITY),
      buildProviderAccount(ANTHROPIC_IDENTITY),
    ]);

    expect(rows.map((row) => row.name)).toEqual(["OpenAI", "Anthropic"]);
  });
});

describe("parseSessionCap", () => {
  it("accepts a whole number of 1 or more, with spaces around it", () => {
    expect(parseSessionCap("8")).toBe(8);
    expect(parseSessionCap(" 16 ")).toBe(16);
  });

  it("refuses 0, text, decimals, negatives and numbers too big to be exact", () => {
    for (const text of ["0", "", "many", "2.5", "-3", "1e3", "99999999999999999999"]) {
      expect(parseSessionCap(text)).toBeUndefined();
    }
  });
});

describe("parseDiskLimit", () => {
  it("reads gigabytes of 10^9 bytes, with at most one decimal", () => {
    expect(parseDiskLimit("10")).toBe(10_000_000_000);
    expect(parseDiskLimit("12.5")).toBe(12_500_000_000);
    expect(parseDiskLimit(" 0.1 ")).toBe(100_000_000);
  });

  it("refuses 0, text, two decimals, a comma and a sign", () => {
    for (const text of ["0", "0.0", "", "lots", "1.25", "1,5", "-2", "+2", "1e3"]) {
      expect(parseDiskLimit(text)).toBeUndefined();
    }
  });
});

describe("formatDiskLimit", () => {
  it("shows the default 10 GiB as 10.7", () => {
    expect(formatDiskLimit(10 * GIB)).toBe("10.7");
  });

  it("drops a trailing .0", () => {
    expect(formatDiskLimit(50_000_000_000)).toBe("50");
    expect(formatDiskLimit(12_500_000_000)).toBe("12.5");
  });

  it("gives the text that parseDiskLimit reads back for a limit the user typed", () => {
    expect(parseDiskLimit(formatDiskLimit(12_500_000_000))).toBe(12_500_000_000);
  });

  it("does not give back the stored bytes of the default, which is why an unchanged field must not save", () => {
    expect(parseDiskLimit(formatDiskLimit(10 * GIB))).not.toBe(10 * GIB);
  });
});

describe("changeRunnerLabels", () => {
  it("adds a label at the end and removes one by name", () => {
    expect(changeRunnerLabels(["gpu"], { kind: "add", label: "fast" })).toEqual(["gpu", "fast"]);
    expect(changeRunnerLabels(["gpu", "fast"], { kind: "remove", label: "gpu" })).toEqual(["fast"]);
  });

  it("keeps the labels as they are when the label is already there", () => {
    const labels = ["gpu"];

    expect(changeRunnerLabels(labels, { kind: "add", label: "gpu" })).toBe(labels);
  });
});

describe("validateRunnerLabel", () => {
  it("returns the label without spaces around it", () => {
    expect(validateRunnerLabel("  gpu ", [])).toEqual({ label: "gpu" });
  });

  it("returns undefined for empty text, which is no label and no error", () => {
    expect(validateRunnerLabel("   ", [])).toBeUndefined();
  });

  it("refuses a label longer than 64 characters, and accepts one of exactly 64", () => {
    expect(validateRunnerLabel("a".repeat(65), [])).toHaveProperty("refusal");
    expect(validateRunnerLabel("a".repeat(64), [])).toEqual({ label: "a".repeat(64) });
  });

  it("refuses a label the machine already has", () => {
    expect(validateRunnerLabel("gpu", ["gpu"])).toEqual({
      refusal: 'This machine already has the label "gpu".',
    });
  });

  it("refuses a 65th label", () => {
    const labels = Array.from({ length: 64 }, (_, index) => `label-${String(index)}`);

    expect(validateRunnerLabel("one more", labels)).toHaveProperty("refusal");
  });
});
