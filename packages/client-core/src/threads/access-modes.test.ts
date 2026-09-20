/**
 * `accessModeMenu(declared, providerName)` renders the four access modes with
 * their fixed meaning and the downward fallback of spec 06 §8.4, whose
 * annotation names the provider that decided it (spec 14 §The composer:
 * `runs as auto-accept-edits on pi`, ticket #70).
 *
 * `AccessMode` is defined in `@hercule/protocol` (packages/protocol/src/sessions.ts)
 * and re-exported unchanged by `@hercule/contract`, which is the only dependency
 * this package already declares.
 */
import { describe, expect, it } from "vitest";
import type { AccessMode } from "@hercule/contract";
import { accessModeMenu } from "./access-modes";

/** The provider's display name, as the row that names the fallback reads it. */
const PROVIDER = "Claude Code";

const ALL_NATIVE: Record<AccessMode, "native" | "unsupported"> = {
  "approval-required": "native",
  "auto-accept-edits": "native",
  auto: "native",
  "full-access": "native",
};

describe("accessModeMenu", () => {
  it("lists the four modes in order with their fixed meaning, none dimmed when every mode is native", () => {
    const items = accessModeMenu(ALL_NATIVE, PROVIDER);

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
    const items = accessModeMenu({ ...ALL_NATIVE, auto: "unsupported" }, PROVIDER);

    expect(items.find((item) => item.mode === "auto")).toMatchObject({
      dimmed: "runs as auto-accept-edits on Claude Code",
    });
  });

  it("walks past an also-unsupported mode down to the next native one", () => {
    const items = accessModeMenu(
      { ...ALL_NATIVE, auto: "unsupported", "full-access": "unsupported" },
      PROVIDER,
    );

    expect(items.find((item) => item.mode === "full-access")).toMatchObject({
      dimmed: "runs as auto-accept-edits on Claude Code",
    });
  });

  it("names the provider it was given, not a fixed phrase standing in for one", () => {
    const items = accessModeMenu({ ...ALL_NATIVE, auto: "unsupported" }, "pi");

    expect(items.find((item) => item.mode === "auto")).toMatchObject({
      dimmed: "runs as auto-accept-edits on pi",
    });
  });

  it("never dims approval-required, even when it is itself declared unsupported", () => {
    const items = accessModeMenu({ ...ALL_NATIVE, "approval-required": "unsupported" }, PROVIDER);

    expect(items.find((item) => item.mode === "approval-required")).toMatchObject({
      dimmed: null,
    });
  });
});
