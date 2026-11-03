import { describe, expect, it } from "vitest";
import type { Harness, Runner, RunnerFacts } from "@hercule/contract";
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
  describeMachinePage,
  formatDiskLimit,
  listMachineAccounts,
  listMachineHarnesses,
  parseDiskLimit,
  parseSessionCap,
  validateRunnerLabel,
  type MachinePage,
  type OfflineBanner,
} from "./machine-page";
import type { SessionCountsByRunner } from "./fleet";

const GIB = 1024 ** 3;
const TIMEZONE = "UTC";
const TODAY = new Date("2026-11-02T14:00:00.000Z");

const buildFacts = (over: Partial<RunnerFacts> = {}): RunnerFacts => ({
  ...BARE.facts!,
  os: "darwin",
  arch: "arm64",
  totalMemoryBytes: 64 * GIB,
  ...over,
});

/** Describes the page of `BARE` with the changes `overrides` make, as the controller of `controllerVersion` shows it. */
const describePage = (
  overrides: Partial<Runner> = {},
  counts: Partial<SessionCountsByRunner[string]> = {},
  controllerVersion = BARE.version ?? "0.4.2",
): MachinePage => {
  const runner = { ...BARE, name: "atlas", ...overrides };
  return describeMachinePage(
    runner,
    { [runner.id]: { running: 0, waiting: 0, waitingThreads: 0, openThreads: 0, ...counts } },
    controllerVersion,
    TIMEZONE,
    TODAY,
  );
};

const readText = (parts: readonly { readonly text: string }[]): string =>
  parts.map((part) => part.text).join("");

describe("describeMachinePage head", () => {
  it("names the machine, its icon and its status", () => {
    expect(describePage().head).toMatchObject({
      name: "atlas",
      kind: "desktop",
      status: { tone: "online", label: "Online" },
    });
  });

  it("names the operating system, keeps the architecture, and counts memory in binary gigabytes", () => {
    expect(describePage().head.facts).toEqual(["macOS", "arm64", "64 GB memory"]);
    expect(
      describePage({
        facts: buildFacts({ os: "linux", arch: "x64", totalMemoryBytes: 32 * GIB }),
      }).head.facts,
    ).toEqual(["Linux", "x64", "32 GB memory"]);
    expect(describePage({ facts: buildFacts({ os: "win32" }) }).head.facts[0]).toBe("Windows");
  });

  it("shows an operating system it does not know as the runner reported it", () => {
    expect(describePage({ facts: buildFacts({ os: "freebsd" }) }).head.facts[0]).toBe("freebsd");
  });

  it.each(["__proto__", "constructor", "toString", "hasOwnProperty"])(
    "shows the operating system %s as the runner reported it",
    (os) => {
      expect(describePage({ facts: buildFacts({ os }) }).head.facts[0]).toBe(os);
    },
  );

  it("rounds memory to a whole gigabyte", () => {
    const facts = buildFacts({ totalMemoryBytes: 15.6 * GIB });

    expect(describePage({ facts }).head.facts[2]).toBe("16 GB memory");
  });

  it("adds the disk's size in gigabytes of 10^9 bytes when the runner reported it", () => {
    expect(describePage({ facts: buildFacts({ diskTotalBytes: 1000e9 }) }).head.facts).toEqual([
      "macOS",
      "arm64",
      "64 GB memory",
      "1,000 GB disk",
    ]);
    expect(describePage({ facts: buildFacts({ diskTotalBytes: 245.4e9 }) }).head.facts[3]).toBe(
      "245 GB disk",
    );
    expect(describePage({ facts: buildFacts({ diskTotalBytes: 64.2e9 }) }).head.facts[3]).toBe(
      "64.2 GB disk",
    );
  });

  it("has no facts before the runner reported them", () => {
    expect(describePage({ facts: null }).head.facts).toEqual([]);
  });

  it("words the runner's version, and has no line without one", () => {
    expect(describePage({ version: "0.4.1" }, {}, "0.4.1").head.runner).toEqual({
      text: "Runner 0.4.1",
      updateText: null,
    });
    expect(describePage({ version: null }).head.runner).toBeNull();
  });

  it("says an update is available when the controller's release is newer in any of the three numbers", () => {
    for (const controller of ["0.9.4", "0.10.0", "1.0.0"]) {
      expect(describePage({ version: "0.9.3" }, {}, controller).head.runner?.updateText).toBe(
        "update available",
      );
    }
  });

  it("compares numbers, not text, so 0.9.3 is behind 0.10.0", () => {
    expect(describePage({ version: "0.9.3" }, {}, "0.10.0").head.runner?.updateText).not.toBeNull();
    expect(describePage({ version: "0.10.0" }, {}, "0.9.3").head.runner?.updateText).toBeNull();
  });

  it("says nothing when the runner is on the same release or a newer one", () => {
    expect(describePage({ version: "0.9.3" }, {}, "0.9.3").head.runner?.updateText).toBeNull();
    expect(describePage({ version: "0.9.4" }, {}, "0.9.3").head.runner?.updateText).toBeNull();
  });

  it("ignores build metadata, so two builds of one release are not behind", () => {
    const updateText = (runner: string, controller: string) =>
      describePage({ version: runner }, {}, controller).head.runner?.updateText;

    expect(updateText("0.1.0+aaaaaaaaa", "0.1.0+bbbbbbbbb")).toBeNull();
    expect(updateText("0.1.0+aaaaaaaaa", "0.1.1+bbbbbbbbb")).toBe("update available");
  });

  it("ranks a pre-release below its release", () => {
    const updateText = (runner: string, controller: string) =>
      describePage({ version: runner }, {}, controller).head.runner?.updateText;

    expect(updateText("0.9.3-rc.1", "0.9.3")).toBe("update available");
    expect(updateText("0.9.3", "0.9.3-rc.1")).toBeNull();
    expect(updateText("0.9.3-rc.1", "0.9.3-rc.2")).toBe("update available");
  });

  it("says nothing when a version has no known order", () => {
    expect(describePage({ version: "0.9.2" }, {}, "edge").head.runner?.updateText).toBeNull();
    expect(describePage({ version: "edge" }, {}, "0.9.2").head.runner?.updateText).toBeNull();
  });
});

describe("describeMachinePage top", () => {
  const line = (overrides: Partial<Runner> = {}, counts = {}) => {
    const { top } = describePage(overrides, counts);
    if (top.kind !== "room") throw new Error("expected a room line");
    return top.line;
  };
  const banner = (overrides: Partial<Runner> = {}, openThreads = 0) => {
    const { top } = describePage(
      { connectivity: "offline", lastSeenAt: "2026-11-02T09:12:00.000Z", ...overrides },
      { openThreads },
    );
    if (top.kind !== "away") throw new Error("expected a banner");
    return top.banner;
  };
  const readBanner = (offline: OfflineBanner) => `${offline.headline} ${readText(offline.detail)}`;

  it("counts the room under the cap, with the number apart from the words", () => {
    expect(line({ maxConcurrentSessions: 16 }, { running: 12 })).toEqual([
      { text: "Room for ", kind: "plain" },
      { text: "4", kind: "number" },
      { text: " more, under its cap of 16", kind: "plain" },
    ]);
  });

  it("says no room when every slot is taken, with the singular for a cap of one", () => {
    expect(readText(line({ maxConcurrentSessions: 16 }, { running: 16 }))).toBe(
      "No room: it runs its cap of 16 sessions",
    );
    expect(readText(line({ maxConcurrentSessions: 1 }, { running: 1 }))).toBe(
      "No room: it runs its cap of 1 session",
    );
  });

  it("names the disk for a disk below its limit", () => {
    const metrics = { diskFreeBytes: 5 * GIB, availableMemoryBytes: 8 * GIB };

    expect(readText(line({ metrics }))).toBe(
      "No room: its disk is below its limit, so it takes no new sessions",
    );
  });

  it("says a machine told to take no new work takes none", () => {
    expect(readText(line({ lifecycle: "draining" }))).toBe("No room: it takes no new work");
  });

  it("still names the disk when the machine is also told to take no new work", () => {
    const metrics = { diskFreeBytes: 5 * GIB, availableMemoryBytes: 8 * GIB };

    expect(readText(line({ lifecycle: "draining", metrics }))).toBe(
      "No room: its disk is below its limit, so it takes no new sessions",
    );
  });

  it.each(["offline", "unreachable"] as const)(
    "shows the banner and no room line while the machine is %s",
    (connectivity) => {
      expect(describePage({ connectivity }).top.kind).toBe("away");
    },
  );

  it("words the spec's banner, with the time the runner was last heard from", () => {
    expect(readBanner(banner({}, 3))).toBe(
      "atlas has not been heard from since 09:12. It may be asleep, off the network, or without power. Its 3 threads can carry on once it is back, and work waiting for it starts then. If it does not come back by itself, start Hercule on it again: hercule service start. What you see below is from 09:12.",
    );
  });

  it("marks the command to draw as code", () => {
    expect(banner({}, 3).detail.filter((part) => part.kind === "code")).toEqual([
      { text: "hercule service start", kind: "code" },
    ]);
  });

  it("says 1 thread in the singular", () => {
    expect(readBanner(banner({}, 1))).toContain("Its 1 thread can carry on");
  });

  it("leaves the sentence about threads out at 0", () => {
    const text = readBanner(banner({}, 0));

    expect(text).not.toContain("thread");
    expect(text).toContain("without power. If it does not come back by itself");
  });

  it("words a runner that was never heard from without a time", () => {
    expect(readBanner(banner({ lastSeenAt: null }))).toBe(
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
    expect(parseSessionCap("8")).toEqual({ value: 8 });
    expect(parseSessionCap(" 16 ")).toEqual({ value: 16 });
  });

  it("refuses 0, text, decimals, negatives and numbers too big to be exact, and says what to type", () => {
    for (const text of ["0", "", "many", "2.5", "-3", "1e3", "99999999999999999999"]) {
      expect(parseSessionCap(text)).toEqual({
        refusal: "The session cap must be a whole number of 1 or more, such as 8.",
      });
    }
  });
});

describe("parseDiskLimit", () => {
  it("reads gigabytes of 10^9 bytes, with at most one decimal", () => {
    expect(parseDiskLimit("10")).toEqual({ value: 10_000_000_000 });
    expect(parseDiskLimit("12.5")).toEqual({ value: 12_500_000_000 });
    expect(parseDiskLimit(" 0.1 ")).toEqual({ value: 100_000_000 });
  });

  it("refuses 0, text, two decimals, a comma and a sign", () => {
    for (const text of ["0", "0.0", "", "lots", "1.25", "1,5", "-2", "+2", "1e3"]) {
      expect(parseDiskLimit(text)).toHaveProperty("refusal");
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
    expect(parseDiskLimit(formatDiskLimit(12_500_000_000))).toEqual({ value: 12_500_000_000 });
  });

  it("does not give back the stored bytes of the default, which is why an unchanged field must not save", () => {
    expect(parseDiskLimit(formatDiskLimit(10 * GIB))).not.toEqual({ value: 10 * GIB });
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
    expect(validateRunnerLabel("  gpu ", [])).toEqual({ value: "gpu" });
  });

  it("returns undefined for empty text, which is no label and no error", () => {
    expect(validateRunnerLabel("   ", [])).toBeUndefined();
  });

  it("refuses a label longer than 64 characters, and accepts one of exactly 64", () => {
    expect(validateRunnerLabel("a".repeat(65), [])).toHaveProperty("refusal");
    expect(validateRunnerLabel("a".repeat(64), [])).toEqual({ value: "a".repeat(64) });
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

describe("describeMachinePage instruments", () => {
  const instruments = (
    overrides: Partial<Runner> = {},
    counts: Partial<SessionCountsByRunner[string]> = {},
  ) => describePage(overrides, counts).instruments;

  const metrics = (over: Partial<NonNullable<Runner["metrics"]>> = {}) => ({
    diskFreeBytes: 120e9,
    availableMemoryBytes: 17.6 * GIB,
    ...over,
  });
  const withDisk = (diskFreeBytes: number, diskTotalBytes = 1000e9): Partial<Runner> => ({
    facts: buildFacts({ diskTotalBytes }),
    metrics: metrics({ diskFreeBytes }),
  });

  describe("sessions", () => {
    it("shows the sessions running against the cap, and none waiting", () => {
      expect(instruments({ maxConcurrentSessions: 16 }, { running: 12 }).sessions).toMatchObject({
        value: "12",
        unit: " of 16",
        level: "normal",
        note: "None waiting",
      });
    });

    it("has no meter, so no share", () => {
      expect(instruments({}, { running: 4 }).sessions).not.toHaveProperty("share");
    });

    it("turns you and counts the sessions waiting, whatever they wait for", () => {
      expect(instruments({}, { running: 4, waiting: 3 }).sessions).toMatchObject({
        level: "you",
        note: "3 waiting",
      });
      // Under the cap, so the cap is not what holds the session back.
      expect(instruments({ maxConcurrentSessions: 16 }, { waiting: 1 }).sessions.note).toBe(
        "1 waiting",
      );
    });

    it("shows a dash against the cap while the machine is away, and still counts what waits", () => {
      for (const connectivity of ["offline", "unreachable"] as const) {
        expect(
          instruments({ connectivity, maxConcurrentSessions: 16 }, { running: 4, waiting: 3 })
            .sessions,
        ).toMatchObject({ value: "–", unit: " of 16", level: "normal", note: "3 waiting" });
      }
    });

    it("carries the drawing a card shows for the same machine", () => {
      const drawing = instruments({ maxConcurrentSessions: 17 }, { running: 12, waiting: 3 })
        .sessions.drawing;

      expect(drawing).toMatchObject({ shape: "bar", cap: 17, running: 12, waiting: 3 });
    });
  });

  it("shows CPU, memory and disk as not reported before the first report", () => {
    const { cpu, memory, disk } = instruments({ metrics: null });

    for (const instrument of [cpu, memory, disk]) {
      expect(instrument).toEqual({
        value: "–",
        unit: "",
        freeAmount: "",
        level: "normal",
        share: null,
        note: "Not reported yet",
      });
    }
  });

  describe("cpu", () => {
    it("shows the last minute's mean and peak, rounded down, with no colour", () => {
      const cpu = { averagePercent: 23.9, peakPercent: 61.9 };

      expect(instruments({ metrics: metrics({ cpu }) }).cpu).toEqual({
        value: "23",
        unit: "%",
        freeAmount: "",
        level: "normal",
        share: 0.239,
        note: "Peak 61% in the last minute",
      });
    });

    it("stays normal at a full load", () => {
      const cpu = { averagePercent: 100, peakPercent: 100 };

      expect(instruments({ metrics: metrics({ cpu }) }).cpu).toMatchObject({
        value: "100",
        level: "normal",
        share: 1,
      });
    });

    it("says the first reading comes within a minute while the runner has none yet", () => {
      expect(instruments({ metrics: metrics({ cpu: null }) }).cpu).toEqual({
        value: "–",
        unit: "",
        freeAmount: "",
        level: "normal",
        share: null,
        note: "First reading within a minute",
      });
    });

    it("says what to do when the runner is too old to report CPU", () => {
      expect(instruments({ metrics: metrics() }).cpu).toEqual({
        value: "–",
        unit: "",
        freeAmount: "",
        level: "normal",
        share: null,
        note: "This machine's runner is too old to report CPU. Update it.",
      });
    });
  });

  describe("memory", () => {
    it("shows the share in use, and the free memory of the total in binary gigabytes", () => {
      expect(instruments({ metrics: metrics() }).memory).toMatchObject({
        value: "72",
        unit: "%",
        level: "normal",
        note: "17.6 GB free of 64 GB",
      });
    });

    it("counts a free amount from 100 GB in whole gigabytes", () => {
      const facts = buildFacts({ totalMemoryBytes: 256 * GIB });

      expect(
        instruments({ facts, metrics: metrics({ availableMemoryBytes: 120.4 * GIB }) }).memory.note,
      ).toBe("120 GB free of 256 GB");
    });

    it("is not reported until the runner has reported its facts", () => {
      expect(instruments({ facts: null, metrics: metrics() }).memory.note).toBe("Not reported yet");
    });
  });

  describe("disk", () => {
    it("shows the share in use, and the free space of the total in gigabytes of 10^9 bytes", () => {
      expect(instruments(withDisk(120e9)).disk).toEqual({
        value: "88",
        unit: "%",
        freeAmount: "120 GB",
        level: "you",
        share: 0.88,
        note: "120 GB free of 1,000 GB",
      });
    });

    it("shows free space with an empty meter, and says what to do, without the disk's total", () => {
      expect(instruments({ metrics: metrics({ diskFreeBytes: 42.14e9 }) }).disk).toEqual({
        value: "42.1",
        unit: " GB free",
        freeAmount: "42.1 GB",
        level: "normal",
        share: null,
        note: "This machine's runner does not report its disk size. Update it to see how full the disk is.",
      });
    });

    it("never shows more free space than the disk holds", () => {
      expect(instruments(withDisk(500e9, 100e9)).disk).toMatchObject({
        value: "0",
        note: "100 GB free of 100 GB",
      });
    });
  });

  it("keeps the last values of a machine that is away", () => {
    const away = instruments({ connectivity: "offline", ...withDisk(120e9) });

    expect(away.disk).toMatchObject({ value: "88", note: "120 GB free of 1,000 GB" });
  });
});
