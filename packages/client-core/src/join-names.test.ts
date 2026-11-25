import { describe, expect, it } from "vitest";
import { joinNamesWithOr } from "./join-names";

describe("joinNamesWithOr", () => {
  it.each([
    ["no names", [], ""],
    ["one name", ["Codex"], "Codex"],
    ["two names", ["Codex", "pi"], "Codex or pi"],
    ["more names", ["Claude Code", "Codex", "pi"], "Claude Code, Codex or pi"],
  ])("lists %s", (_name, names, expected) => {
    expect(joinNamesWithOr(names)).toBe(expected);
  });
});
