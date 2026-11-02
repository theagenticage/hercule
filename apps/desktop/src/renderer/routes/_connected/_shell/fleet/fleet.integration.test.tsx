/**
 * Tests the Fleet page through the rendered app: the lead, the machines as
 * cards and as rows, the view that survives leaving the page, Allow saving a
 * machine's session cap, the card that adds a machine while the fleet is
 * empty, and a card opening its machine's page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Runner, RunnerFacts, Session } from "@hercule/contract";
import {
  buildErrorBody,
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  stubIntersectionObserver,
  type Call,
  type Handler,
} from "../../../../app/testing";
import { rememberMachineView } from "../../../../screens/fleet/machine-view";

const GIB = 1024 ** 3;

beforeEach(() => {
  // Monday 2 November 2026, 14:00 in UTC, the time zone the settings name.
  vi.useFakeTimers({ now: new Date("2026-11-02T14:00:00.000Z"), toFake: ["Date"] });
  rememberMachineView("grid");
  stubIntersectionObserver();
});

afterEach(() => {
  vi.useRealTimers();
});

const FACTS: RunnerFacts = {
  os: "linux",
  arch: "x64",
  totalMemoryBytes: 32 * GIB,
  docker: false,
  toolchains: [],
  harnesses: [],
  adapters: [],
  identityPort: 7000,
};

const buildRunner = (id: string, name: string, over: Partial<Runner> = {}): Runner => ({
  id,
  name,
  connectivity: "online",
  lifecycle: "active",
  reserved: false,
  version: "0.9.3",
  labels: [],
  facts: FACTS,
  watermark: { diskFreeBytes: 200 * GIB, availableMemoryBytes: 24 * GIB },
  maxConcurrentSessions: 16,
  diskWatermarkBytes: 10 * GIB,
  lastSeenAt: "2026-11-02T13:59:00.000Z",
  ...over,
});

const ATLAS = buildRunner("01a06d02-a000-7000-8000-000000000001", "atlas");
const FORGE = buildRunner("01a06d02-a000-7000-8000-000000000002", "forge", {
  watermark: { diskFreeBytes: 5 * GIB, availableMemoryBytes: 24 * GIB },
});
const NOMAD = buildRunner("01a06d02-a000-7000-8000-000000000003", "nomad", {
  connectivity: "offline",
  lastSeenAt: "2026-11-02T09:12:00.000Z",
});
const RUNNERS = [ATLAS, FORGE, NOMAD];

let sessionNumber = 0;

/** Returns a session of the fixture's first thread, running on `runner` in `status`. */
const buildSessionOn = (runner: Runner, status: "busy" | "queued"): Session => {
  sessionNumber += 1;
  return {
    ...SIDEBAR_FIXTURE.threads[0]!,
    id: `01a06d02-b000-7000-8000-${String(sessionNumber).padStart(12, "0")}`,
    runnerId: runner.id,
    status,
    openRequests: [],
  };
};

/** Atlas runs 12 sessions under its cap of 16 and has 5 more waiting. Forge runs 2. */
const SESSIONS = [
  ...Array.from({ length: 12 }, () => buildSessionOn(ATLAS, "busy")),
  ...Array.from({ length: 5 }, () => buildSessionOn(ATLAS, "queued")),
  ...Array.from({ length: 2 }, () => buildSessionOn(FORGE, "busy")),
];

/**
 * Opens the app at the Fleet page with `runners`, which the controller keeps
 * in `held` so an update shows in the next read. The controller's own runner
 * is `localRunnerId`. `handlers` replace the stub's answers.
 */
const openFleet = async ({
  runners = RUNNERS,
  localRunnerId = null,
  handlers = {},
}: {
  readonly runners?: readonly Runner[];
  readonly localRunnerId?: string | null;
  readonly handlers?: Readonly<Record<string, Handler>>;
} = {}) => {
  let held = runners;
  const calls = stubApi({
    ...buildSidebarHandlers({ ...SIDEBAR_FIXTURE, runners: [] }),
    "GET /api/v1/runners": () => ({ body: { items: held } }),
    "GET /api/v1/sessions": () => ({ body: { items: SESSIONS } }),
    "GET /api/v1/settings": { body: { controller: {}, user: { timezone: "UTC" } } },
    "GET /api/v1/controller": {
      body: {
        id: "01a06d02-c000-7000-8000-000000000001",
        publicKey: "key",
        version: "0.9.3",
        defaultRunnerId: null,
        localRunnerId,
        textGeneration: { model: null, unavailableReason: null, lastFailure: null },
      },
    },
    ...Object.fromEntries(
      runners.map((runner): [string, Handler] => [
        `PATCH /api/v1/runners/${runner.id}`,
        (call: Call) => {
          // `runner.update` answers with the runner's detail.
          const updated = {
            ...runner,
            ...(call.body as { maxConcurrentSessions: number }),
            negotiatedCapabilities: null,
            protocolVersion: null,
          };
          held = held.map((each) => (each.id === runner.id ? updated : each));
          return { body: updated };
        },
      ]),
    ),
    ...handlers,
  });
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    {
      path: "/fleet",
    },
  );
  await screen.findByRole("navigation", { name: "Fleet" });
  return { calls, ...app };
};

/** Returns the card of the machine `name`: the element that holds its open button. */
const getCard = (name: string): HTMLElement => {
  const card = screen.getByRole("button", { name }).closest<HTMLElement>(".fleet-card");
  if (card === null) throw new Error(`${name} has no card`);
  return card;
};

/** Returns the element that draws exactly `text` in bold, such as the "12 of 16" a card splits in two. */
const getValue = (within_: HTMLElement, text: string): HTMLElement =>
  within(within_).getByText(
    (_, element) => element?.tagName === "B" && element.textContent === text,
  );

describe("the Fleet page", () => {
  it("leads with how many machines need the user, then shows a card for each machine", async () => {
    await openFleet();

    expect((await screen.findByRole("heading", { level: 2, name: /need you/ })).textContent).toBe(
      "Three machines need you.",
    );
    const atlas = getCard("atlas");
    expect(getValue(atlas, "12 of 16")).toBeTruthy();
    expect(within(atlas).getByText("5 threads wait for a slot")).toBeTruthy();
    const nomad = getCard("nomad");
    expect(within(nomad).getByText("Offline since 09:12")).toBeTruthy();
    expect(
      within(screen.getByRole("navigation", { name: "Fleet" })).getByText("3 need you"),
    ).toBeTruthy();
  });

  it("shows the same machines as rows in the list, and keeps the choice after leaving and coming back", async () => {
    const user = userEvent.setup();
    const { router } = await openFleet();

    await user.click(screen.getByRole("button", { name: "List" }));
    const table = await screen.findByRole("table", { name: "Machines" });
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(within(table).getByText("12 of 16 · 5 waiting")).toBeTruthy();

    await user.click(within(table).getByRole("button", { name: "forge" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/fleet/${FORGE.id}`));
    await router.navigate({ to: "/fleet" });

    expect(await screen.findByRole("table", { name: "Machines" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "List" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("opens a machine's page from its card", async () => {
    const user = userEvent.setup();
    const { router } = await openFleet();

    await user.click(within(getCard("atlas")).getByRole("button", { name: "atlas" }));

    await waitFor(() => expect(router.state.location.pathname).toBe(`/fleet/${ATLAS.id}`));
  });

  it("sets the session cap to the sessions running plus waiting when Allow is pressed", async () => {
    const user = userEvent.setup();
    const { calls } = await openFleet();

    await user.click(within(getCard("atlas")).getByRole("button", { name: "Allow 17" }));

    await waitFor(() => expect(getValue(getCard("atlas"), "12 of 17")).toBeTruthy());
    const update = calls.find((call) => call.method === "PATCH");
    expect(update?.path).toBe(`/api/v1/runners/${ATLAS.id}`);
    expect(update?.body).toEqual({ maxConcurrentSessions: 17 });
    // The machine no longer has threads waiting for a slot.
    expect(within(getCard("atlas")).queryByRole("button", { name: /Allow/ })).toBeNull();
  });

  it("shows the controller's message when Allow fails, and leaves the cap as it was", async () => {
    const user = userEvent.setup();
    await openFleet({
      handlers: {
        [`PATCH /api/v1/runners/${ATLAS.id}`]: {
          status: 409,
          body: buildErrorBody("conflict", "The runner is being retired."),
        },
      },
    });

    await user.click(within(getCard("atlas")).getByRole("button", { name: "Allow 17" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Could not allow 17 sessions on atlas: The runner is being retired.",
    );
    expect(getValue(getCard("atlas"), "12 of 16")).toBeTruthy();
  });

  it("invites the user to add a machine while only the controller's own runner is online", async () => {
    const user = userEvent.setup();
    await openFleet({
      runners: [ATLAS],
      localRunnerId: ATLAS.id,
      handlers: {
        "GET /api/v1/runners/join-tokens": { body: [] },
        "POST /api/v1/runners/join-tokens": {
          status: 201,
          body: {
            id: "01a06d02-7400-7000-8000-00000000fe5a",
            token: "hjt_fresh",
            expiresAt: "2026-11-02T15:00:00.000Z",
          },
        },
      },
    });

    await user.click(screen.getByRole("button", { name: /Add a machine\./ }));

    expect(await screen.findByRole("dialog", { name: "Add a machine" })).toBeTruthy();
  });

  it("does not show the card that adds a machine once another machine is online", async () => {
    await openFleet({ localRunnerId: ATLAS.id });

    expect(screen.queryByRole("button", { name: /Add a machine\./ })).toBeNull();
  });
});
