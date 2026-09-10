/**
 * `runnerMenu(runners, localId, instance)` builds the composer's runner
 * selector: one row per runner, dimmed by connectivity, then lifecycle, then
 * login, plus the default selection.
 */
import { describe, expect, it } from "vitest";
import type { Runner } from "@hydra/contract";
import { referenceRunner, runnerMenu } from "./runner-menu";
import { BARE, instance, snapshot } from "../providers.testing";

const runner = (overrides: Partial<Runner> & { id: string }): Runner => ({
  ...BARE,
  ...overrides,
});

describe("runnerMenu", () => {
  it("dims an offline or unreachable runner over everything else, even draining and no login", () => {
    const claude = instance("claude-code", "Claude Code", []); // logged in nowhere

    const offlineDraining = runner({
      id: "r-offline",
      name: "offline-box",
      connectivity: "offline",
      lifecycle: "draining",
    });
    expect(runnerMenu([offlineDraining], null, claude).rows[0]).toMatchObject({
      dimmed: "offline",
    });

    const unreachable = runner({
      id: "r-unreachable",
      name: "unreachable-box",
      connectivity: "unreachable",
      lifecycle: "active",
    });
    expect(runnerMenu([unreachable], null, claude).rows[0]).toMatchObject({
      dimmed: "unreachable",
    });
  });

  it("derives the state word: lifecycle when the runner is not active, else connectivity", () => {
    const claude = instance("claude-code", "Claude Code", []);

    expect(
      runnerMenu(
        [runner({ id: "r-1", name: "a", connectivity: "online", lifecycle: "active" })],
        null,
        claude,
      ).rows[0],
    ).toMatchObject({ state: "online" });

    expect(
      runnerMenu(
        [runner({ id: "r-2", name: "b", connectivity: "online", lifecycle: "retired" })],
        null,
        claude,
      ).rows[0],
    ).toMatchObject({ state: "retired" });

    expect(
      runnerMenu(
        [runner({ id: "r-3", name: "c", connectivity: "offline", lifecycle: "draining" })],
        null,
        claude,
      ).rows[0],
    ).toMatchObject({ state: "draining" });
  });

  it("dims a draining online runner as draining, even with a valid login", () => {
    const draining = runner({
      id: "r-drain",
      name: "drain-box",
      connectivity: "online",
      lifecycle: "draining",
    });
    const claude = instance("claude-code", "Claude Code", [
      snapshot({
        runnerId: "r-drain",
        auth: { status: "ok", identity: "rogier@example.com", planLabel: "Claude Max" },
      }),
    ]);

    const menu = runnerMenu([draining], null, claude);

    expect(menu.rows[0]).toMatchObject({
      dimmed: "draining",
      identity: "rogier@example.com",
      planLabel: "Claude Max",
    });
  });

  it("dims an online, non-draining runner with no ok snapshot for the instance as not logged in", () => {
    const active = runner({
      id: "r-active",
      name: "active-box",
      connectivity: "online",
      lifecycle: "active",
    });
    const claude = instance("claude-code", "Claude Code", []); // no snapshot for r-active

    const menu = runnerMenu([active], null, claude);

    expect(menu.rows[0]).toMatchObject({ dimmed: "not logged in" });
  });

  it("marks isLocal true only for the runner whose id equals localId", () => {
    const a = runner({ id: "r-a", name: "a" });
    const b = runner({ id: "r-b", name: "b" });
    const claude = instance("claude-code", "Claude Code", [
      snapshot({ runnerId: "r-a" }),
      snapshot({ runnerId: "r-b" }),
    ]);

    const menu = runnerMenu([a, b], "r-b", claude);

    expect(menu.rows.map((row) => ({ id: row.runnerId, isLocal: row.isLocal }))).toEqual([
      { id: "r-a", isLocal: false },
      { id: "r-b", isLocal: true },
    ]);
  });

  it("defaults to the local runner when it is present among the runners", () => {
    const a = runner({ id: "r-a", name: "a" });
    const b = runner({ id: "r-b", name: "b" });
    const claude = instance("claude-code", "Claude Code", [
      snapshot({ runnerId: "r-a" }),
      snapshot({ runnerId: "r-b" }),
    ]);

    expect(runnerMenu([a, b], "r-b", claude).defaultRunnerId).toBe("r-b");
  });

  it("defaults to the first not-dimmed row when localId is absent or matches no runner", () => {
    const dimmed = runner({ id: "r-a", name: "a", connectivity: "offline" });
    const ok = runner({ id: "r-b", name: "b", connectivity: "online", lifecycle: "active" });
    const claude = instance("claude-code", "Claude Code", [snapshot({ runnerId: "r-b" })]);

    expect(runnerMenu([dimmed, ok], null, claude).defaultRunnerId).toBe("r-b");
    expect(runnerMenu([dimmed, ok], "not-a-runner-id", claude).defaultRunnerId).toBe("r-b");
  });

  it("falls through to the first not-dimmed row when the local runner is itself dimmed", () => {
    const localDimmed = runner({ id: "r-local", name: "local", connectivity: "offline" });
    const ok = runner({ id: "r-b", name: "b", connectivity: "online", lifecycle: "active" });
    const claude = instance("claude-code", "Claude Code", [snapshot({ runnerId: "r-b" })]);

    expect(runnerMenu([localDimmed, ok], "r-local", claude).defaultRunnerId).toBe("r-b");
  });

  it("has no default runner when every row is dimmed", () => {
    const offline = runner({ id: "r-a", name: "a", connectivity: "offline" });
    const draining = runner({
      id: "r-b",
      name: "b",
      connectivity: "online",
      lifecycle: "draining",
    });
    const claude = instance("claude-code", "Claude Code", []);

    expect(runnerMenu([offline, draining], null, claude).defaultRunnerId).toBeNull();
  });
});

describe("referenceRunner", () => {
  it("picks the selected runner when one is selected, dimmed or not", () => {
    const a = runner({ id: "r-a", name: "a", connectivity: "offline" });
    const b = runner({ id: "r-b", name: "b" });

    expect(referenceRunner([a, b], "r-a", "r-b")).toBe(a);
  });

  it("falls back to the local runner when nothing is selected", () => {
    const a = runner({ id: "r-a", name: "a" });
    const b = runner({ id: "r-b", name: "b" });

    expect(referenceRunner([a, b], null, "r-b")).toBe(b);
  });

  it("falls back to the first runner in the list when nothing is selected and there is no local runner", () => {
    const a = runner({ id: "r-a", name: "a" });
    const b = runner({ id: "r-b", name: "b" });

    expect(referenceRunner([a, b], null, null)).toBe(a);
    expect(referenceRunner([a, b], "not-a-runner-id", "also-not-one")).toBe(a);
  });

  it("has nothing to name when there are no runners at all", () => {
    expect(referenceRunner([], null, null)).toBeUndefined();
  });
});
