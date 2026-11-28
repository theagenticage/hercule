/**
 * Tests `pushRecent(recent, entry)`, which keeps the last 24 entries
 * (account, harness, model) the user picked, newest first; `buildRecentModel`,
 * which decides which entry a successful submission adds, from the picks the
 * submission was sent with and the thread it resolved to; and
 * `parseRecentModels`, which reads that list back from the JSON text a client
 * stored.
 */
import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_IDENTITY,
  buildProviderAccount,
  HARNESSES,
  PROVIDERS,
} from "../providers.testing";
import type { ThreadCatalogs, ThreadConfig, ThreadPicks } from "./config";
import { buildRecentModel, parseRecentModels, pushRecent } from "./recent";
import { resolveThreadConfig } from "./resolve-thread";
import { applyThreadChoice } from "./thread-choice";

const WORK = "account-anthropic-work";
const PERSONAL = "account-anthropic-personal";
const CLAUDE = "claude-code/claude-code";
const PI = "pi/pi";
const SONNET = "claude-sonnet-5";
const OPUS = "claude-opus-5";
const HAIKU = "claude-haiku-5";

describe("buildRecentModel", () => {
  const BASE: ThreadConfig = {
    providerAccountId: WORK,
    harnessId: null,
    model: SONNET,
    accessMode: "approval-required",
    runnerId: null,
    profileId: null,
    options: {},
  };
  const CATALOGS: ThreadCatalogs = {
    accounts: [
      buildProviderAccount({ ...ANTHROPIC_IDENTITY, id: WORK }),
      buildProviderAccount({ ...ANTHROPIC_IDENTITY, id: PERSONAL }),
    ],
    runners: [],
    thisMacRunnerId: null,
    providers: PROVIDERS,
    harnesses: HARNESSES,
    modelProfiles: [],
  };
  const resolveDraftThread = (picks: ThreadPicks, config: ThreadConfig = BASE) =>
    resolveThreadConfig(CATALOGS, { kind: "draft", config }, picks);

  it("adds the entry the user picked, with the account, harness and model the thread resolved to", () => {
    const picks = applyThreadChoice(
      { options: { effort: "high" } },
      { kind: "model", providerAccountId: PERSONAL, harnessId: PI, model: OPUS },
    );
    const resolved = resolveDraftThread(picks, { ...BASE, providerAccountId: PERSONAL });
    expect(buildRecentModel(picks, resolved)).toEqual({
      providerAccountId: PERSONAL,
      harnessId: PI,
      model: OPUS,
    });
  });

  it("adds nothing when the user picked no model, since Recent never holds a default", () => {
    const picks: ThreadPicks = { options: { effort: "high" } };
    expect(buildRecentModel({}, resolveDraftThread({}))).toBeNull();
    expect(buildRecentModel({ model: null }, resolveDraftThread({ model: null }))).toBeNull();
    expect(buildRecentModel(picks, resolveDraftThread(picks))).toBeNull();
  });

  it("adds nothing for a thread with no account", () => {
    const picks: ThreadPicks = { model: OPUS };
    expect(
      buildRecentModel(picks, resolveDraftThread(picks, { ...BASE, providerAccountId: null })),
    ).toBeNull();
  });
});

describe("pushRecent", () => {
  const SONNET_ENTRY = { providerAccountId: WORK, harnessId: CLAUDE, model: SONNET };
  const OPUS_ENTRY = { providerAccountId: WORK, harnessId: CLAUDE, model: OPUS };

  it("starts the list with the first pick", () => {
    expect(pushRecent([], SONNET_ENTRY)).toEqual([SONNET_ENTRY]);
  });

  it("puts the newest entry first", () => {
    expect(pushRecent([SONNET_ENTRY], OPUS_ENTRY)).toEqual([OPUS_ENTRY, SONNET_ENTRY]);
  });

  it("moves an entry that is already in the list to the front rather than adding it twice", () => {
    expect(pushRecent([SONNET_ENTRY, OPUS_ENTRY], OPUS_ENTRY)).toEqual([OPUS_ENTRY, SONNET_ENTRY]);
  });

  it("treats the same model on another account as another entry", () => {
    const personal = { ...SONNET_ENTRY, providerAccountId: PERSONAL };
    expect(pushRecent([SONNET_ENTRY], personal)).toEqual([personal, SONNET_ENTRY]);
  });

  it("treats the same model in another harness as another entry", () => {
    const inPi = { ...SONNET_ENTRY, harnessId: PI };
    expect(pushRecent([SONNET_ENTRY], inPi)).toEqual([inPi, SONNET_ENTRY]);
  });

  it("keeps the last 24 picks, dropping the oldest, so one profile's picks do not push out another's", () => {
    const full = Array.from({ length: 24 }, (_, index) => ({
      ...SONNET_ENTRY,
      model: `m-${index}`,
    }));
    const next = pushRecent(full, OPUS_ENTRY);
    expect(next).toHaveLength(24);
    expect(next[0]).toEqual(OPUS_ENTRY);
    expect(next[23]).toEqual({ ...SONNET_ENTRY, model: "m-22" });
  });
});

describe("parseRecentModels", () => {
  it("reads the stored entries in their order", () => {
    const stored = JSON.stringify([
      { providerAccountId: WORK, harnessId: CLAUDE, model: OPUS },
      { providerAccountId: PERSONAL, harnessId: PI, model: SONNET },
    ]);
    expect(parseRecentModels(stored)).toEqual([
      { providerAccountId: WORK, harnessId: CLAUDE, model: OPUS },
      { providerAccountId: PERSONAL, harnessId: PI, model: SONNET },
    ]);
  });

  it("reads the key instanceId of a list stored before Provider Accounts as providerAccountId", () => {
    const stored = JSON.stringify([
      { instanceId: WORK, harnessId: CLAUDE, model: OPUS },
      { providerAccountId: PERSONAL, harnessId: CLAUDE, model: SONNET },
    ]);
    expect(parseRecentModels(stored)).toEqual([
      { providerAccountId: WORK, harnessId: CLAUDE, model: OPUS },
      { providerAccountId: PERSONAL, harnessId: CLAUDE, model: SONNET },
    ]);
  });

  it("drops an entry stored without a harness, and keeps the others", () => {
    const stored = JSON.stringify([
      { providerAccountId: WORK, model: OPUS },
      { providerAccountId: PERSONAL, harnessId: CLAUDE, model: SONNET },
    ]);
    expect(parseRecentModels(stored)).toEqual([
      { providerAccountId: PERSONAL, harnessId: CLAUDE, model: SONNET },
    ]);
  });

  it("reads nothing stored as an empty list", () => {
    expect(parseRecentModels(null)).toEqual([]);
  });

  it("reads text that is not JSON as an empty list", () => {
    expect(parseRecentModels("[{providerAccountId")).toEqual([]);
  });

  it("reads JSON that is not a list of entries as an empty list", () => {
    expect(parseRecentModels(JSON.stringify({ providerAccountId: WORK, model: OPUS }))).toEqual([]);
    expect(parseRecentModels(JSON.stringify([{ providerAccountId: WORK }]))).toEqual([]);
    expect(parseRecentModels(JSON.stringify([{ harnessId: CLAUDE, model: OPUS }]))).toEqual([]);
    expect(
      parseRecentModels(JSON.stringify([{ providerAccountId: WORK, harnessId: CLAUDE, model: 3 }])),
    ).toEqual([]);
  });

  it("reads a list stored when the limit was three as it is", () => {
    const stored = JSON.stringify([
      { providerAccountId: WORK, harnessId: CLAUDE, model: OPUS },
      { providerAccountId: WORK, harnessId: CLAUDE, model: SONNET },
      { providerAccountId: WORK, harnessId: CLAUDE, model: HAIKU },
    ]);
    expect(parseRecentModels(stored)).toHaveLength(3);
  });

  it("keeps only the 24 newest entries of a longer stored list", () => {
    const stored = JSON.stringify(
      Array.from({ length: 30 }, (_, index) => ({
        providerAccountId: WORK,
        harnessId: CLAUDE,
        model: `m-${index}`,
      })),
    );
    const parsed = parseRecentModels(stored);
    expect(parsed).toHaveLength(24);
    expect(parsed[0]?.model).toBe("m-0");
    expect(parsed[23]?.model).toBe("m-23");
  });
});
