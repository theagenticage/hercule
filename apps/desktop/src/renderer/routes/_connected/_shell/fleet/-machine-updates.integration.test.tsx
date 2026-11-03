/**
 * Tests the quiet updates line of the Fleet page's cards and rows, through the
 * rendered app. Which versions count as an update is decided by
 * `describeFleetUpdates` in `@hercule/client-core/software`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { HARNESSES } from "@hercule/client-core/testing";
import type { Harness, Runner } from "@hercule/contract";
import {
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  stubIntersectionObserver,
} from "../../../../app/testing";
import { rememberMachineView } from "../../../../screens/fleet/machine-view";

const GIB = 1024 ** 3;

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-11-02T14:00:00.000Z"), toFake: ["Date"] });
  stubIntersectionObserver();
});

afterEach(() => {
  vi.useRealTimers();
});

const buildRunner = (id: string, name: string, version: string): Runner => ({
  id,
  name,
  connectivity: "online",
  lifecycle: "active",
  reserved: false,
  version,
  labels: [],
  facts: {
    os: "linux",
    arch: "x64",
    totalMemoryBytes: 32 * GIB,
    docker: false,
    toolchains: [],
    harnesses: [],
    adapters: [],
    identityPort: 7000,
  },
  metrics: { diskFreeBytes: 200 * GIB, availableMemoryBytes: 24 * GIB },
  maxConcurrentSessions: 16,
  diskWatermarkBytes: 10 * GIB,
  lastSeenAt: "2026-11-02T13:59:00.000Z",
});

/** The controller is on 0.9.4: atlas runs 0.9.3 and has Claude Code 1.0.0, forge is up to date. */
const ATLAS = buildRunner("01a06d02-a000-7000-8000-000000000001", "atlas", "0.9.3");
const FORGE = buildRunner("01a06d02-a000-7000-8000-000000000002", "forge", "0.9.4");

/** Claude Code has a release 1.2.0, and is installed at 1.0.0 on atlas and at 1.2.0 on forge. */
const OLD_CLAUDE_CODE: readonly Harness[] = HARNESSES.map((harness) =>
  harness.id === "claude-code/claude-code"
    ? {
        ...harness,
        latestRelease: {
          lastGoodRead: { version: "1.2.0", checkedAt: "2026-11-02T13:00:00.000Z" },
          error: null,
        },
        runners: [
          { runnerId: ATLAS.id, installed: true, version: "1.0.0", versionVerdict: "ok" },
          { runnerId: FORGE.id, installed: true, version: "1.2.0", versionVerdict: "ok" },
        ],
      }
    : harness,
);

const openFleet = async (view: "grid" | "list") => {
  rememberMachineView(view);
  stubApi({
    ...buildSidebarHandlers({ ...SIDEBAR_FIXTURE, runners: [] }),
    "GET /api/v1/runners": { body: { items: [ATLAS, FORGE] } },
    "GET /api/v1/sessions": { body: { items: [] } },
    "GET /api/v1/harnesses": { body: OLD_CLAUDE_CODE },
    "GET /api/v1/settings": { body: { controller: {}, user: { timezone: "UTC" } } },
    "GET /api/v1/controller": {
      body: {
        id: "01a06d02-c000-7000-8000-000000000001",
        publicKey: "key",
        version: "0.9.4",
        defaultRunnerId: null,
        localRunnerId: null,
        textGeneration: { model: null, unavailableReason: null, lastFailure: null },
      },
    },
  });
  await renderApp(createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }), {
    path: "/fleet",
  });
  await screen.findByRole("button", { name: "atlas" });
};

describe("the updates line on the Fleet page", () => {
  it("counts the runner and the harnesses older than their latest release on a machine's card, and draws none on a machine that is up to date", async () => {
    await openFleet("grid");

    const atlas = screen.getByRole("button", { name: "atlas" }).closest(".fleet-card")!;
    const forge = screen.getByRole("button", { name: "forge" }).closest(".fleet-card")!;
    expect(within(atlas as HTMLElement).getByText("2 updates")).toBeTruthy();
    expect(forge.querySelector(".fleet-updates")).toBeNull();
  });

  it("draws the same line in the Needs you cell of the machine's row", async () => {
    await openFleet("list");

    const atlas = screen.getByRole("button", { name: "atlas" }).closest("[role=row]")!;
    const forge = screen.getByRole("button", { name: "forge" }).closest("[role=row]")!;
    expect(within(atlas as HTMLElement).getByText("2 updates")).toBeTruthy();
    expect(forge.querySelector(".fleet-updates")).toBeNull();
  });
});
