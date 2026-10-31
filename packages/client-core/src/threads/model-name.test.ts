/**
 * Tests `findModelName(account, harnessId, slug)` and `describeAgent(providers,
 * account, harnessId, model)`, which name a thread's model from its Provider
 * Account's catalogs.
 */
import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_IDENTITY,
  PROVIDERS,
  buildProviderAccount,
  buildSnapshot,
} from "../providers.testing";
import { describeAgent, findModelName } from "./model-name";

const HARNESS = ANTHROPIC_IDENTITY.harnessId;

/** An account with a catalog on two runners; only the second lists Opus. */
const CLAUDE = buildProviderAccount(ANTHROPIC_IDENTITY, [
  buildSnapshot({
    runnerId: "atlas",
    models: [{ slug: "default", name: "Default", imageInput: { maxBytes: null }, options: [] }],
  }),
  buildSnapshot({
    runnerId: "bare",
    models: [
      { slug: "claude-opus-5-5", name: "Opus 5.5", imageInput: { maxBytes: null }, options: [] },
    ],
  }),
]);

describe("findModelName", () => {
  it("finds the name in any runner's catalog of the account", () => {
    expect(findModelName(CLAUDE, HARNESS, "claude-opus-5-5")).toBe("Opus 5.5");
  });

  it("reads only the snapshots of the harness the thread runs in", () => {
    expect(findModelName(CLAUDE, "pi/pi", "claude-opus-5-5")).toBe("claude-opus-5-5");
  });

  it("returns the slug when no catalog lists it", () => {
    expect(findModelName(CLAUDE, HARNESS, "claude-haiku-4-5")).toBe("claude-haiku-4-5");
  });

  it("returns the slug when the account is gone", () => {
    expect(findModelName(undefined, HARNESS, "claude-opus-5-5")).toBe("claude-opus-5-5");
  });
});

describe("describeAgent", () => {
  it("joins the account's name and the model's name", () => {
    expect(describeAgent(PROVIDERS, CLAUDE, HARNESS, "claude-opus-5-5")).toBe(
      "Anthropic · Opus 5.5",
    );
  });

  it("includes the label of a labelled account", () => {
    const work = { ...CLAUDE, label: "work" };
    expect(describeAgent(PROVIDERS, work, HARNESS, "claude-opus-5-5")).toBe(
      "Anthropic · work · Opus 5.5",
    );
  });

  it("leaves out the account's name when the account is gone", () => {
    expect(describeAgent(PROVIDERS, undefined, HARNESS, "claude-opus-5-5")).toBe("claude-opus-5-5");
  });
});
