/**
 * Tests what happens when a machine is retired from its page: the Fleet page
 * never draws the retired machine while the runners are read again, and a
 * user who left the machine's page while the request ran is not sent back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HARNESSES } from "@hercule/client-core/testing";
import type { Runner } from "@hercule/contract";
import {
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  holdAnswer,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  stubIntersectionObserver,
  type Answer,
} from "../../../../app/testing";

beforeEach(() => {
  stubIntersectionObserver();
  vi.stubEnv("TZ", "UTC");
  vi.useFakeTimers({ now: new Date("2026-11-02T14:00:00.000Z"), toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  localStorage.clear();
});

const [BASE] = SIDEBAR_FIXTURE.runners;
const ATLAS: Runner = {
  ...BASE!,
  id: "01a06d02-0000-7000-8000-00000000a710",
  name: "atlas",
  connectivity: "online",
  lifecycle: "active",
};
const MOSS: Runner = { ...ATLAS, id: "01a06d02-0000-7000-8000-00000000b055", name: "moss" };

/** What the controller answers `runner.retire` with: the runner, retired. */
const RETIRED: Answer = {
  body: { ...ATLAS, lifecycle: "retired", negotiatedCapabilities: null, protocolVersion: null },
};

/**
 * Opens atlas's page, beside moss. The controller's answer to retire is held
 * until the test calls `answerRetire`, and after it every read of the runners
 * is held until `answerRunners`, so a test can look at the screen while a
 * read runs. The controller still lists atlas as active then, as one that has
 * not yet read the retire does.
 */
const openMachineWithHeldRetire = async () => {
  const retire = holdAnswer();
  const runnersRead = holdAnswer();
  let retired = false;
  const calls = stubApi({
    ...buildSidebarHandlers({ ...SIDEBAR_FIXTURE, runners: [] }),
    "GET /api/v1/runners": () =>
      retired ? runnersRead.handler() : Promise.resolve({ body: { items: [ATLAS, MOSS] } }),
    "GET /api/v1/sessions": { body: { items: [] } },
    "GET /api/v1/harnesses": { body: HARNESSES },
    "GET /api/v1/settings": { body: { controller: {}, user: { timezone: "UTC" } } },
    "GET /api/v1/controller": {
      body: {
        id: "01a06d02-c000-7000-8000-000000000001",
        publicKey: "key",
        version: "0.9.3",
        defaultRunnerId: null,
        localRunnerId: null,
        textGeneration: { model: null, unavailableReason: null, lastFailure: null },
      },
    },
    [`POST /api/v1/runners/${ATLAS.id}/retire`]: retire.handler,
  });
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    { path: `/fleet/${ATLAS.id}` },
  );
  await screen.findByRole("heading", { level: 2, name: "atlas" });
  await userEvent.click(
    within(screen.getByRole("region", { name: "Settings" })).getByRole("button", {
      name: "Retire…",
    }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Retire atlas?" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Retire" }));
  return {
    ...app,
    calls,
    dialog,
    answerRetire: () => {
      retired = true;
      retire.answer(RETIRED);
    },
    answerRunners: () => {
      runnersRead.answer({ body: { items: [MOSS] } });
    },
  };
};

describe("retiring a machine from its page", () => {
  it("goes to Fleet and never draws the retired machine while the runners are read again", async () => {
    const { router, answerRetire, answerRunners } = await openMachineWithHeldRetire();

    answerRetire();

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/fleet");
    });
    // The read that follows is still running, and the controller's last list holds atlas.
    await screen.findByRole("button", { name: "moss" });
    expect(screen.queryByRole("button", { name: "atlas" })).toBeNull();

    answerRunners();
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "atlas" })).toBeNull();
    });
  });

  it("does not send the user back to Fleet from a page they went to while the request ran", async () => {
    const { router, calls, dialog, answerRetire, answerRunners } =
      await openMachineWithHeldRetire();
    const runnerReads = () =>
      calls.filter((call) => call.method === "GET" && call.path === "/api/v1/runners").length;
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await act(async () => {
      await router.navigate({ to: "/fleet/$runnerId", params: { runnerId: MOSS.id } });
    });

    const readsBefore = runnerReads();
    answerRetire();
    // The retire is answered after the user has left, and still reads the runners again.
    await waitFor(() => {
      expect(runnerReads()).toBeGreaterThan(readsBefore);
    });
    answerRunners();

    expect(router.state.location.pathname).toBe(`/fleet/${MOSS.id}`);
    expect(await screen.findByRole("heading", { level: 2, name: "moss" })).toBeTruthy();
  });
});
