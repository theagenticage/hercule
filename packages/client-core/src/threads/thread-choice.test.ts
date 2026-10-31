/**
 * Tests `applyThreadChoice(picks, choice)`, which records one selector choice
 * in the picks. It is pure: it never looks at a catalog, so a choice is kept
 * even when nothing can honour it now. What applies is decided by
 * `resolveThreadConfig` (see `resolve-thread.test.ts`).
 */
import { describe, expect, it } from "vitest";
import type { ThreadPicks } from "./config";
import { applyThreadChoice } from "./thread-choice";

describe("applyThreadChoice", () => {
  it("records a model together with its account and harness", () => {
    expect(
      applyThreadChoice(
        {},
        { kind: "model", providerAccountId: "a-openai", harnessId: "pi/pi", model: "gpt-5" },
      ),
    ).toEqual({ providerAccountId: "a-openai", harnessId: "pi/pi", model: "gpt-5" });
  });

  it("replaces the account, harness and model of an earlier model choice, and keeps the other picks", () => {
    const held: ThreadPicks = {
      providerAccountId: "a-anthropic",
      harnessId: "claude-code/claude-code",
      model: "claude-opus-5",
      runnerId: "r-remote",
      options: { effort: "max" },
    };
    expect(
      applyThreadChoice(held, {
        kind: "model",
        providerAccountId: "a-openai",
        harnessId: "codex/codex",
        model: "gpt-5",
      }),
    ).toEqual({
      providerAccountId: "a-openai",
      harnessId: "codex/codex",
      model: "gpt-5",
      runnerId: "r-remote",
      options: { effort: "max" },
    });
  });

  it("merges an option into the options already picked, and keeps an explicit false", () => {
    const first = applyThreadChoice(
      { options: { effort: "low" } },
      {
        kind: "option",
        id: "thinking",
        value: false,
      },
    );
    expect(first).toEqual({ options: { effort: "low", thinking: false } });
    expect(applyThreadChoice(first, { kind: "option", id: "effort", value: "max" })).toEqual({
      options: { effort: "max", thinking: false },
    });
  });

  it("sets the runner, the workspace and the access mode", () => {
    const workspace = { kind: "existing", workspaceId: "ws-1" } as const;
    expect(applyThreadChoice({}, { kind: "runner", runnerId: "r-remote" })).toEqual({
      runnerId: "r-remote",
    });
    expect(applyThreadChoice({}, { kind: "workspace", workspace })).toEqual({ workspace });
    expect(applyThreadChoice({}, { kind: "accessMode", value: "full-access" })).toEqual({
      accessMode: "full-access",
    });
  });
});
