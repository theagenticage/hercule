/**
 * Tests `buildAccessModeMenu(declared, providerName)`, which lists the four
 * access modes with their fixed meaning. A mode the provider does not support
 * falls back downward, to the nearest less permissive mode it does support
 * (spec 06 §8.4). A dimmed mode's note names the provider that falls back, as
 * in `runs as auto-accept-edits on pi`.
 *
 * `AccessMode` is defined in `@hercule/protocol`
 * (packages/protocol/src/sessions.ts) and re-exported unchanged by
 * `@hercule/contract`, which is the only one of the two this package depends
 * on.
 */
import { describe, expect, it } from "vitest";
import type { AccessMode } from "@hercule/contract";
import { buildAccessModeMenu } from "./access-modes";

/** The provider's display name, as used in a dimmed row's note. */
const PROVIDER = "Claude Code";

const ALL_NATIVE: Record<AccessMode, "native" | "unsupported"> = {
  "approval-required": "native",
  "auto-accept-edits": "native",
  auto: "native",
  "full-access": "native",
};

describe("buildAccessModeMenu", () => {
  it("lists the four modes in order with their fixed meaning, none dimmed when every mode is native", () => {
    const items = buildAccessModeMenu(ALL_NATIVE, PROVIDER);

    expect(items.map((item) => item.mode)).toEqual([
      "approval-required",
      "auto-accept-edits",
      "auto",
      "full-access",
    ]);
    expect(items.map((item) => item.meaning)).toEqual([
      "asks for every side-effecting action",
      "allows file edits, asks for the rest",
      "lets a harness-side reviewer judge routine actions",
      "allows everything",
    ]);
    expect(items.every((item) => item.dimmed === null)).toBe(true);
  });

  it("dims auto with its fallback when auto-accept-edits is the nearest native mode below it", () => {
    const items = buildAccessModeMenu({ ...ALL_NATIVE, auto: "unsupported" }, PROVIDER);

    expect(items.find((item) => item.mode === "auto")).toMatchObject({
      dimmed: "runs as auto-accept-edits on Claude Code",
    });
  });

  it("walks past an also-unsupported mode down to the next native one", () => {
    const items = buildAccessModeMenu(
      { ...ALL_NATIVE, auto: "unsupported", "full-access": "unsupported" },
      PROVIDER,
    );

    expect(items.find((item) => item.mode === "full-access")).toMatchObject({
      dimmed: "runs as auto-accept-edits on Claude Code",
    });
  });

  it("names the given provider, not a fixed placeholder", () => {
    const items = buildAccessModeMenu({ ...ALL_NATIVE, auto: "unsupported" }, "pi");

    expect(items.find((item) => item.mode === "auto")).toMatchObject({
      dimmed: "runs as auto-accept-edits on pi",
    });
  });

  it("never dims approval-required, even when it is declared unsupported", () => {
    const items = buildAccessModeMenu(
      { ...ALL_NATIVE, "approval-required": "unsupported" },
      PROVIDER,
    );

    expect(items.find((item) => item.mode === "approval-required")).toMatchObject({
      dimmed: null,
    });
  });
});
