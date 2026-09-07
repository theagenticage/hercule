import { describe, expect, it } from "vitest";
import { sessionsEmptyState } from "./sessions-empty-state";
import { BARE, instance, snapshot, WITH_CLAUDE } from "./providers.fixture";

/** A machine that has the harness and has never been logged in on it. */
const waiting = instance("claude-code", "Claude Code", [
  snapshot({ auth: { status: "unauthenticated" } }),
]);

/** The same instance, logged in. */
const loggedIn = instance("claude-code", "Claude Code", [snapshot()]);

/** A provider this runner build cannot drive at all. */
const undrivable = instance("codex", "Codex", [
  snapshot({
    auth: { status: "error", message: "no adapter for codex in this runner build" },
  }),
]);

describe("sessionsEmptyState", () => {
  it("has nothing to offer when no runner answered on this machine", () => {
    expect(sessionsEmptyState(null, [waiting])).toEqual({ kind: "no-runner" });
  });

  it("reads a local runner that is not connected as no runner at all", () => {
    // The screen offers a login, and a login runs on the machine: a row that
    // says `offline` can no more be logged in to than one that is absent.
    expect(sessionsEmptyState({ ...WITH_CLAUDE, connectivity: "offline" }, [waiting])).toEqual({
      kind: "no-runner",
    });
  });

  it("says the machine has no harness when it reported none", () => {
    expect(sessionsEmptyState(BARE, [waiting, undrivable])).toEqual({ kind: "no-harness" });
  });

  it("offers a login for every harness that is there and not logged in", () => {
    expect(sessionsEmptyState(WITH_CLAUDE, [waiting, undrivable])).toEqual({
      kind: "log-in",
      instances: [waiting],
    });
  });

  it("still offers the login when the last probe of a harness that is here failed", () => {
    // A probe that timed out says nothing about whether the harness can be
    // logged in, and telling the user to install what is already there would
    // send them nowhere.
    const stale = instance("claude-code", "Claude Code", [
      snapshot({
        auth: { status: "error", message: "the harness did not answer within 15s" },
      }),
    ]);
    expect(sessionsEmptyState(WITH_CLAUDE, [stale])).toEqual({
      kind: "log-in",
      instances: [stale],
    });
  });

  it("is ready once one instance on this machine is logged in", () => {
    expect(sessionsEmptyState(WITH_CLAUDE, [loggedIn])).toEqual({
      kind: "ready",
      name: "Claude Code",
    });
  });

  it("is ready even when another instance is still waiting for a login", () => {
    // One usable harness is what the screen is about; the rest is Fleet's
    // business, and a "log in" headline over a working install reads as broken.
    const second = instance("codex", "Codex", [snapshot({ auth: { status: "unauthenticated" } })]);
    expect(sessionsEmptyState(WITH_CLAUDE, [second, loggedIn])).toEqual({
      kind: "ready",
      name: "Claude Code",
    });
  });
});
