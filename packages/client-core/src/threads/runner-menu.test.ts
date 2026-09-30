/**
 * Tests `buildRunnerMenu(runners, localId, instance)`, which builds the
 * composer's runner selector: one row per runner that is not retired, dimmed for connectivity,
 * then lifecycle, then login, plus the default runner.
 */
import { describe, expect, it } from "vitest";
import type { Runner } from "@hercule/contract";
import { findReferenceRunner, buildRunnerMenu } from "./runner-menu";
import { BARE, buildInstance, buildSnapshot } from "../providers.testing";

const buildRunner = (overrides: Partial<Runner> & { id: string }): Runner => ({
  ...BARE,
  ...overrides,
});

describe("buildRunnerMenu", () => {
  it("dims an offline or unreachable runner for that reason first, even when it is also draining and not logged in", () => {
    const claude = buildInstance("claude-code", "Claude Code", []); // logged in nowhere

    const offlineDraining = buildRunner({
      id: "r-offline",
      name: "offline-box",
      connectivity: "offline",
      lifecycle: "draining",
    });
    expect(buildRunnerMenu([offlineDraining], null, claude).rows[0]).toMatchObject({
      dimmed: "offline",
    });

    const unreachable = buildRunner({
      id: "r-unreachable",
      name: "unreachable-box",
      connectivity: "unreachable",
      lifecycle: "active",
    });
    expect(buildRunnerMenu([unreachable], null, claude).rows[0]).toMatchObject({
      dimmed: "unreachable",
    });
  });

  it("derives the state: draining when the runner is draining, else the connectivity", () => {
    const claude = buildInstance("claude-code", "Claude Code", []);

    expect(
      buildRunnerMenu(
        [buildRunner({ id: "r-1", name: "a", connectivity: "online", lifecycle: "active" })],
        null,
        claude,
      ).rows[0],
    ).toMatchObject({ state: "online" });

    expect(
      buildRunnerMenu(
        [buildRunner({ id: "r-3", name: "c", connectivity: "offline", lifecycle: "draining" })],
        null,
        claude,
      ).rows[0],
    ).toMatchObject({ state: "draining" });
  });

  it("leaves retired runners out, so none can be the default", () => {
    const retired = buildRunner({ id: "r-gone", name: "gone", lifecycle: "retired" });
    const claude = buildInstance("claude-code", "Claude Code", [
      buildSnapshot({ runnerId: "r-gone" }),
    ]);

    const menu = buildRunnerMenu([retired], "r-gone", claude);

    expect(menu.rows).toEqual([]);
    expect(menu.defaultRunnerId).toBeNull();
  });

  it("dims a draining online runner as draining, even with a valid login", () => {
    const draining = buildRunner({
      id: "r-drain",
      name: "drain-box",
      connectivity: "online",
      lifecycle: "draining",
    });
    const claude = buildInstance("claude-code", "Claude Code", [
      buildSnapshot({
        runnerId: "r-drain",
        auth: { status: "ok", identity: "rogier@example.com", planLabel: "Claude Max" },
      }),
    ]);

    const menu = buildRunnerMenu([draining], null, claude);

    expect(menu.rows[0]).toMatchObject({
      dimmed: "draining",
      identity: "rogier@example.com",
      planLabel: "Claude Max",
    });
  });

  it("dims an online, non-draining runner with no ok snapshot for the instance as not logged in", () => {
    const active = buildRunner({
      id: "r-active",
      name: "active-box",
      connectivity: "online",
      lifecycle: "active",
    });
    const claude = buildInstance("claude-code", "Claude Code", []); // no snapshot for r-active

    const menu = buildRunnerMenu([active], null, claude);

    expect(menu.rows[0]).toMatchObject({ dimmed: "not logged in" });
  });

  it("marks isLocal true only for the runner whose id equals localId", () => {
    const a = buildRunner({ id: "r-a", name: "a" });
    const b = buildRunner({ id: "r-b", name: "b" });
    const claude = buildInstance("claude-code", "Claude Code", [
      buildSnapshot({ runnerId: "r-a" }),
      buildSnapshot({ runnerId: "r-b" }),
    ]);

    const menu = buildRunnerMenu([a, b], "r-b", claude);

    expect(menu.rows.map((row) => ({ id: row.runnerId, isLocal: row.isLocal }))).toEqual([
      { id: "r-a", isLocal: false },
      { id: "r-b", isLocal: true },
    ]);
  });

  it("defaults to the local runner when it is present among the runners", () => {
    const a = buildRunner({ id: "r-a", name: "a" });
    const b = buildRunner({ id: "r-b", name: "b" });
    const claude = buildInstance("claude-code", "Claude Code", [
      buildSnapshot({ runnerId: "r-a" }),
      buildSnapshot({ runnerId: "r-b" }),
    ]);

    expect(buildRunnerMenu([a, b], "r-b", claude).defaultRunnerId).toBe("r-b");
  });

  it("defaults to the first not-dimmed row when localId is absent or matches no runner", () => {
    const dimmed = buildRunner({ id: "r-a", name: "a", connectivity: "offline" });
    const ok = buildRunner({ id: "r-b", name: "b", connectivity: "online", lifecycle: "active" });
    const claude = buildInstance("claude-code", "Claude Code", [
      buildSnapshot({ runnerId: "r-b" }),
    ]);

    expect(buildRunnerMenu([dimmed, ok], null, claude).defaultRunnerId).toBe("r-b");
    expect(buildRunnerMenu([dimmed, ok], "not-a-runner-id", claude).defaultRunnerId).toBe("r-b");
  });

  it("falls through to the first not-dimmed row when the local runner is itself dimmed", () => {
    const localDimmed = buildRunner({ id: "r-local", name: "local", connectivity: "offline" });
    const ok = buildRunner({ id: "r-b", name: "b", connectivity: "online", lifecycle: "active" });
    const claude = buildInstance("claude-code", "Claude Code", [
      buildSnapshot({ runnerId: "r-b" }),
    ]);

    expect(buildRunnerMenu([localDimmed, ok], "r-local", claude).defaultRunnerId).toBe("r-b");
  });

  it("has no default runner when every row is dimmed", () => {
    const offline = buildRunner({ id: "r-a", name: "a", connectivity: "offline" });
    const draining = buildRunner({
      id: "r-b",
      name: "b",
      connectivity: "online",
      lifecycle: "draining",
    });
    const claude = buildInstance("claude-code", "Claude Code", []);

    expect(buildRunnerMenu([offline, draining], null, claude).defaultRunnerId).toBeNull();
  });
});

describe("findReferenceRunner", () => {
  it("picks the selected runner when one is selected, dimmed or not", () => {
    const a = buildRunner({ id: "r-a", name: "a", connectivity: "offline" });
    const b = buildRunner({ id: "r-b", name: "b" });

    expect(findReferenceRunner([a, b], "r-a", "r-b")).toBe(a);
  });

  it("falls back to the local runner when nothing is selected", () => {
    const a = buildRunner({ id: "r-a", name: "a" });
    const b = buildRunner({ id: "r-b", name: "b" });

    expect(findReferenceRunner([a, b], null, "r-b")).toBe(b);
  });

  it("falls back to the first runner in the list when nothing is selected and there is no local runner", () => {
    const a = buildRunner({ id: "r-a", name: "a" });
    const b = buildRunner({ id: "r-b", name: "b" });

    expect(findReferenceRunner([a, b], null, null)).toBe(a);
    expect(findReferenceRunner([a, b], "not-a-runner-id", "also-not-one")).toBe(a);
  });

  it("keeps a selected runner even when it is retired, since a started thread keeps its runner", () => {
    const retired = buildRunner({ id: "r-gone", name: "gone", lifecycle: "retired" });
    const b = buildRunner({ id: "r-b", name: "b" });

    expect(findReferenceRunner([retired, b], "r-gone", null)).toBe(retired);
  });

  it("skips retired runners when it falls back", () => {
    const retiredLocal = buildRunner({ id: "r-local", name: "local", lifecycle: "retired" });
    const b = buildRunner({ id: "r-b", name: "b" });

    expect(findReferenceRunner([retiredLocal, b], null, "r-local")).toBe(b);
    expect(findReferenceRunner([retiredLocal], null, "r-local")).toBeUndefined();
  });

  it("returns undefined when there are no runners", () => {
    expect(findReferenceRunner([], null, null)).toBeUndefined();
  });
});
