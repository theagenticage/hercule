/**
 * Tests `pushRecent(recent, pair)`, which keeps the last three (account,
 * model) pairs the user picked, newest first; `buildRecentModel`, which
 * decides which pair a successful submission adds, from the picks the
 * submission was sent with and the thread it resolved to; and `parseRecentModels`,
 * which reads that list back from the JSON text a client stored.
 */
import { describe, expect, it } from "vitest";
import {
  BARE,
  buildProviderAccount,
  buildSnapshot,
  OPENAI_IDENTITY,
  HARNESSES,
  PROVIDERS,
} from "../providers.testing";
import type { ThreadCatalogs, ThreadConfig, ThreadPicks } from "./config";
import { buildRecentModel, parseRecentModels, pushRecent } from "./recent";
import { resolveThreadConfig } from "./resolve-thread";
import { applyThreadChoice } from "./thread-choice";

const WORK = "account-anthropic-work";
const PERSONAL = "account-anthropic-personal";
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
  const NO_CATALOGS: ThreadCatalogs = {
    accounts: [],
    runners: [],
    thisMacRunnerId: null,
    providers: PROVIDERS,
    harnesses: HARNESSES,
  };
  const resolveDraftThread = (picks: ThreadPicks, config: ThreadConfig = BASE) =>
    resolveThreadConfig(NO_CATALOGS, { kind: "draft", config }, picks);

  it("adds the model the user picked, with the account and model the thread resolved to", () => {
    const picks = applyThreadChoice(
      { options: { effort: "high" } },
      { kind: "model", providerAccountId: PERSONAL, model: OPUS },
    );
    expect(buildRecentModel(picks, resolveDraftThread(picks))).toEqual({
      providerAccountId: PERSONAL,
      model: OPUS,
    });
  });

  it("adds nothing when the user picked no model, since Recent never holds a default", () => {
    const picks: ThreadPicks = { options: { effort: "high" } };
    expect(buildRecentModel({}, resolveDraftThread({}))).toBeNull();
    expect(buildRecentModel({ model: null }, resolveDraftThread({ model: null }))).toBeNull();
    expect(buildRecentModel(picks, resolveDraftThread(picks))).toBeNull();
  });

  it("adds nothing for an account choice alone, whose default model is not a pick", () => {
    const runner = { ...BARE, id: "r-moss" };
    const codex = buildProviderAccount(OPENAI_IDENTITY, [
      buildSnapshot({
        runnerId: runner.id,
        models: [{ slug: "gpt-5", name: "GPT-5", imageInput: null, isDefault: true, options: [] }],
      }),
    ]);
    const catalogs: ThreadCatalogs = {
      accounts: [codex],
      runners: [runner],
      thisMacRunnerId: runner.id,
      providers: PROVIDERS,
      harnesses: HARNESSES,
    };
    const account = applyThreadChoice({}, { kind: "account", providerAccountId: codex.id });
    const resolved = resolveThreadConfig(catalogs, { kind: "draft", config: BASE }, account);

    expect(resolved.config.model).toBe("gpt-5");
    expect(buildRecentModel(account, resolved)).toBeNull();
  });

  it("adds nothing for a thread with no account", () => {
    const picks: ThreadPicks = { model: OPUS };
    expect(
      buildRecentModel(picks, resolveDraftThread(picks, { ...BASE, providerAccountId: null })),
    ).toBeNull();
  });
});

describe("pushRecent", () => {
  it("starts the list with the first pick", () => {
    expect(pushRecent([], { providerAccountId: WORK, model: SONNET })).toEqual([
      { providerAccountId: WORK, model: SONNET },
    ]);
  });

  it("puts the newest pair first", () => {
    expect(
      pushRecent([{ providerAccountId: WORK, model: SONNET }], {
        providerAccountId: WORK,
        model: OPUS,
      }),
    ).toEqual([
      { providerAccountId: WORK, model: OPUS },
      { providerAccountId: WORK, model: SONNET },
    ]);
  });

  it("moves a pair that is already in the list to the front rather than adding it twice", () => {
    expect(
      pushRecent(
        [
          { providerAccountId: WORK, model: SONNET },
          { providerAccountId: WORK, model: OPUS },
        ],
        { providerAccountId: WORK, model: OPUS },
      ),
    ).toEqual([
      { providerAccountId: WORK, model: OPUS },
      { providerAccountId: WORK, model: SONNET },
    ]);
  });

  it("treats the same model on another account as another pair", () => {
    expect(
      pushRecent([{ providerAccountId: WORK, model: SONNET }], {
        providerAccountId: PERSONAL,
        model: SONNET,
      }),
    ).toEqual([
      { providerAccountId: PERSONAL, model: SONNET },
      { providerAccountId: WORK, model: SONNET },
    ]);
  });

  it("caps the list at three, dropping the oldest", () => {
    expect(
      pushRecent(
        [
          { providerAccountId: WORK, model: SONNET },
          { providerAccountId: WORK, model: OPUS },
          { providerAccountId: WORK, model: HAIKU },
        ],
        { providerAccountId: PERSONAL, model: SONNET },
      ),
    ).toEqual([
      { providerAccountId: PERSONAL, model: SONNET },
      { providerAccountId: WORK, model: SONNET },
      { providerAccountId: WORK, model: OPUS },
    ]);
  });
});

describe("parseRecentModels", () => {
  it("reads the stored pairs in their order", () => {
    const stored = JSON.stringify([
      { providerAccountId: WORK, model: OPUS },
      { providerAccountId: PERSONAL, model: SONNET },
    ]);
    expect(parseRecentModels(stored)).toEqual([
      { providerAccountId: WORK, model: OPUS },
      { providerAccountId: PERSONAL, model: SONNET },
    ]);
  });

  it("reads the key instanceId of a list stored before Provider Accounts as providerAccountId", () => {
    const stored = JSON.stringify([
      { instanceId: WORK, model: OPUS },
      { providerAccountId: PERSONAL, model: SONNET },
    ]);
    expect(parseRecentModels(stored)).toEqual([
      { providerAccountId: WORK, model: OPUS },
      { providerAccountId: PERSONAL, model: SONNET },
    ]);
  });

  it("reads nothing stored as an empty list", () => {
    expect(parseRecentModels(null)).toEqual([]);
  });

  it("reads text that is not JSON as an empty list", () => {
    expect(parseRecentModels("[{providerAccountId")).toEqual([]);
  });

  it("reads JSON that is not a list of pairs as an empty list", () => {
    expect(parseRecentModels(JSON.stringify({ providerAccountId: WORK, model: OPUS }))).toEqual([]);
    expect(parseRecentModels(JSON.stringify([{ providerAccountId: WORK }]))).toEqual([]);
    expect(parseRecentModels(JSON.stringify([{ model: OPUS }]))).toEqual([]);
    expect(parseRecentModels(JSON.stringify([{ providerAccountId: WORK, model: 3 }]))).toEqual([]);
  });

  it("keeps only the three newest pairs of a longer stored list", () => {
    const stored = JSON.stringify([
      { providerAccountId: WORK, model: OPUS },
      { providerAccountId: WORK, model: SONNET },
      { providerAccountId: WORK, model: HAIKU },
      { providerAccountId: PERSONAL, model: OPUS },
    ]);
    expect(parseRecentModels(stored)).toEqual([
      { providerAccountId: WORK, model: OPUS },
      { providerAccountId: WORK, model: SONNET },
      { providerAccountId: WORK, model: HAIKU },
    ]);
  });
});
