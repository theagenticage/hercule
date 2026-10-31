/**
 * Tests `buildRunnerMenu(runners, localId, account, harnessId)`, which builds the
 * composer's runner selector: one row per runner that is not retired, dimmed for connectivity,
 * then lifecycle, then the account's readiness there, plus the default runner.
 */
import { describe, expect, it } from "vitest";
import type { Runner } from "@hercule/contract";
import { findReferenceRunner, buildRunnerMenu } from "./runner-menu";
import { WITH_AGENTS, buildProviderAccount, ANTHROPIC_IDENTITY } from "../providers.testing";

const HARNESS = ANTHROPIC_IDENTITY.harnessId;

const buildRunner = (overrides: Partial<Runner> & { id: string }): Runner => ({
  ...WITH_AGENTS,
  ...overrides,
});

/** An account that is ready in Claude Code on each of `runnerIds`. */
const readyOn = (...runnerIds: string[]) =>
  buildProviderAccount(
    ANTHROPIC_IDENTITY,
    [],
    runnerIds.map((runnerId) => ({ runnerId })),
  );

describe("buildRunnerMenu", () => {
  it("dims a runner by the readiness the controller sent for the harness", () => {
    const account = buildProviderAccount(
      ANTHROPIC_IDENTITY,
      [],
      [
        { runnerId: "r-ready" },
        { runnerId: "r-signed-out", state: "not-signed-in" },
        { runnerId: "r-no-key", state: "credential-missing" },
        { runnerId: "r-expired", state: "token-expired" },
        { runnerId: "r-missing", state: "harness-missing" },
        { runnerId: "r-old", state: "harness-too-old" },
      ],
    );
    const runners = [
      "r-ready",
      "r-signed-out",
      "r-no-key",
      "r-expired",
      "r-missing",
      "r-old",
      "r-unknown",
    ].map((id) => buildRunner({ id }));

    const menu = buildRunnerMenu(runners, null, account, HARNESS);

    expect(menu.rows.map((row) => [row.runnerId, row.dimmed])).toEqual([
      ["r-ready", null],
      ["r-signed-out", "not signed in"],
      ["r-no-key", "no key or token"],
      ["r-expired", "token expired"],
      ["r-missing", "not installed"],
      ["r-old", "harness too old"],
      ["r-unknown", "not installed"],
    ]);
    expect(menu.defaultRunnerId).toBe("r-ready");
  });

  it("dims an offline or unreachable runner for that reason first, even when it is also draining and not signed in", () => {
    const claude = buildProviderAccount(
      ANTHROPIC_IDENTITY,
      [],
      [
        { runnerId: "r-offline", state: "not-signed-in" },
        { runnerId: "r-unreachable", state: "not-signed-in" },
      ],
    );

    const offlineDraining = buildRunner({
      id: "r-offline",
      name: "offline-box",
      connectivity: "offline",
      lifecycle: "draining",
    });
    expect(buildRunnerMenu([offlineDraining], null, claude, HARNESS).rows[0]).toMatchObject({
      dimmed: "offline",
    });

    const unreachable = buildRunner({
      id: "r-unreachable",
      name: "unreachable-box",
      connectivity: "unreachable",
      lifecycle: "active",
    });
    expect(buildRunnerMenu([unreachable], null, claude, HARNESS).rows[0]).toMatchObject({
      dimmed: "unreachable",
    });
  });

  it("derives the state: draining when the runner is draining, else the connectivity", () => {
    const claude = readyOn("r-1", "r-3");

    expect(
      buildRunnerMenu(
        [buildRunner({ id: "r-1", name: "a", connectivity: "online", lifecycle: "active" })],
        null,
        claude,
        HARNESS,
      ).rows[0],
    ).toMatchObject({ state: "online" });

    expect(
      buildRunnerMenu(
        [buildRunner({ id: "r-3", name: "c", connectivity: "offline", lifecycle: "draining" })],
        null,
        claude,
        HARNESS,
      ).rows[0],
    ).toMatchObject({ state: "draining" });
  });

  it("leaves retired runners out, so none can be the default", () => {
    const retired = buildRunner({ id: "r-gone", name: "gone", lifecycle: "retired" });

    const menu = buildRunnerMenu([retired], "r-gone", readyOn("r-gone"), HARNESS);

    expect(menu.rows).toEqual([]);
    expect(menu.defaultRunnerId).toBeNull();
  });

  it("dims a draining online runner as draining, even where the account is ready", () => {
    const draining = buildRunner({
      id: "r-drain",
      name: "drain-box",
      connectivity: "online",
      lifecycle: "draining",
    });
    const claude = {
      ...readyOn("r-drain"),
      identity: "rogier@example.com",
      planLabel: "Claude Max",
    };

    const menu = buildRunnerMenu([draining], null, claude, HARNESS);

    expect(menu.rows[0]).toMatchObject({
      dimmed: "draining",
      identity: "rogier@example.com",
      planLabel: "Claude Max",
    });
  });

  it("names who is signed in only on a runner where the account is ready", () => {
    const claude = {
      ...buildProviderAccount(
        ANTHROPIC_IDENTITY,
        [],
        [{ runnerId: "r-a" }, { runnerId: "r-b", state: "not-signed-in" }],
      ),
      identity: "rogier@example.com",
      planLabel: "Claude Max",
    };

    const menu = buildRunnerMenu(
      [buildRunner({ id: "r-a" }), buildRunner({ id: "r-b" })],
      null,
      claude,
      HARNESS,
    );

    expect(menu.rows.map((row) => row.identity)).toEqual(["rogier@example.com", null]);
  });

  it("reads the readiness of the harness the thread runs in, not another harness's", () => {
    const active = buildRunner({ id: "r-active", name: "active-box" });
    const claude = buildProviderAccount(ANTHROPIC_IDENTITY, [], [{ runnerId: "r-active" }]);

    expect(buildRunnerMenu([active], null, claude, HARNESS).rows[0]).toMatchObject({
      dimmed: null,
    });
    expect(buildRunnerMenu([active], null, claude, "pi/pi").rows[0]).toMatchObject({
      dimmed: "not installed",
    });
  });

  it("marks isLocal true only for the runner whose id equals localId", () => {
    const a = buildRunner({ id: "r-a", name: "a" });
    const b = buildRunner({ id: "r-b", name: "b" });

    const menu = buildRunnerMenu([a, b], "r-b", readyOn("r-a", "r-b"), HARNESS);

    expect(menu.rows.map((row) => ({ id: row.runnerId, isLocal: row.isLocal }))).toEqual([
      { id: "r-a", isLocal: false },
      { id: "r-b", isLocal: true },
    ]);
  });

  it("defaults to the local runner when it is present among the runners", () => {
    const a = buildRunner({ id: "r-a", name: "a" });
    const b = buildRunner({ id: "r-b", name: "b" });

    expect(buildRunnerMenu([a, b], "r-b", readyOn("r-a", "r-b"), HARNESS).defaultRunnerId).toBe(
      "r-b",
    );
  });

  it("defaults to the first not-dimmed row when localId is absent or matches no runner", () => {
    const dimmed = buildRunner({ id: "r-a", name: "a", connectivity: "offline" });
    const ok = buildRunner({ id: "r-b", name: "b", connectivity: "online", lifecycle: "active" });
    const claude = readyOn("r-b");

    expect(buildRunnerMenu([dimmed, ok], null, claude, HARNESS).defaultRunnerId).toBe("r-b");
    expect(buildRunnerMenu([dimmed, ok], "not-a-runner-id", claude, HARNESS).defaultRunnerId).toBe(
      "r-b",
    );
  });

  it("falls through to the first not-dimmed row when the local runner is itself dimmed", () => {
    const localDimmed = buildRunner({ id: "r-local", name: "local", connectivity: "offline" });
    const ok = buildRunner({ id: "r-b", name: "b", connectivity: "online", lifecycle: "active" });

    expect(
      buildRunnerMenu([localDimmed, ok], "r-local", readyOn("r-b"), HARNESS).defaultRunnerId,
    ).toBe("r-b");
  });

  it("has no default runner when every row is dimmed", () => {
    const offline = buildRunner({ id: "r-a", name: "a", connectivity: "offline" });
    const draining = buildRunner({
      id: "r-b",
      name: "b",
      connectivity: "online",
      lifecycle: "draining",
    });

    expect(
      buildRunnerMenu([offline, draining], null, readyOn("r-a", "r-b"), HARNESS).defaultRunnerId,
    ).toBeNull();
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
