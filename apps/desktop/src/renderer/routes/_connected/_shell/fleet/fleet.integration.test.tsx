/**
 * Tests the Fleet page through the rendered app: the lead, the machines as
 * cards and as rows, the view that survives leaving the page, Allow saving a
 * machine's session cap, the card that adds a machine while the fleet is
 * empty, a card opening its machine's page, and the Software section with
 * its column heads and its jump link.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HARNESSES } from "@hercule/client-core/testing";
import type { Harness, Runner, RunnerFacts, Session } from "@hercule/contract";
import {
  buildErrorBody,
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  renderApp,
  setVisibility,
  SIDEBAR_FIXTURE,
  stubApi,
  stubIntersectionObserver,
  type Call,
  type Handler,
} from "../../../../app/testing";
import { rememberMachineView } from "../../../../screens/fleet/machine-view";
import { MACHINE_SOFTWARE_ID } from "./-machine-sections";

const GIB = 1024 ** 3;

beforeEach(() => {
  // Monday 2 November 2026, 14:00 in UTC, the time zone the settings name.
  vi.useFakeTimers({ now: new Date("2026-11-02T14:00:00.000Z"), toFake: ["Date"] });
  rememberMachineView("grid");
  stubIntersectionObserver();
});

afterEach(() => {
  vi.useRealTimers();
  setVisibility("visible");
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
  metrics: { diskFreeBytes: 200 * GIB, availableMemoryBytes: 24 * GIB },
  maxConcurrentSessions: 16,
  diskWatermarkBytes: 10 * GIB,
  lastSeenAt: "2026-11-02T13:59:00.000Z",
  ...over,
});

const ATLAS = buildRunner("01a06d02-a000-7000-8000-000000000001", "atlas");
const FORGE = buildRunner("01a06d02-a000-7000-8000-000000000002", "forge", {
  metrics: { diskFreeBytes: 5 * GIB, availableMemoryBytes: 24 * GIB },
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

  it("shows a disk that is 87% full as a percentage with its need line, and the list shows the same", async () => {
    const user = userEvent.setup();
    const orbit = buildRunner("01a06d02-a000-7000-8000-000000000004", "orbit", {
      facts: { ...FACTS, diskTotalBytes: 500 * GIB },
      metrics: { diskFreeBytes: 65 * GIB, availableMemoryBytes: 24 * GIB },
    });
    await openFleet({ runners: [orbit] });

    const card = getCard("orbit");
    expect(getValue(card, "87%")).toBeTruthy();
    expect(within(card).getByText("Disk 87% full")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Clean up…" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "List" }));
    const row = within(await screen.findByRole("table", { name: "Machines" })).getAllByRole(
      "row",
    )[1]!;
    expect(within(row).getByText("87%")).toBeTruthy();
    expect(within(row).getByText("69.8 GB free")).toBeTruthy();
    expect(within(row).getByText("Disk 87% full")).toBeTruthy();
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

    const alert = await within(getCard("atlas")).findByRole("alert");
    expect(alert.textContent).toBe("Could not allow 17 sessions: The runner is being retired.");
    expect(getValue(getCard("atlas"), "12 of 16")).toBeTruthy();
  });

  it("keeps the message of a refused Allow when the view switches between Grid and List", async () => {
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
    await within(getCard("atlas")).findByRole("alert");

    await user.click(screen.getByRole("button", { name: "List" }));

    const table = await screen.findByRole("table", { name: "Machines" });
    expect((await within(table).findByRole("alert")).textContent).toBe(
      "Could not allow 17 sessions: The runner is being retired.",
    );
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

  describe("the faces of the work on a card", () => {
    /** Returns `session` as open on forge, busy. */
    const onForge = (session: Session, over: Partial<Session> = {}): Session => ({
      ...session,
      runnerId: FORGE.id,
      status: "busy",
      openRequests: [],
      ...over,
    });

    it("shows one face per group of the machine's sessions: a run's steps are one face, a row of Threads is one", async () => {
      // The first two fixture Threads share a workspace, so the sidebar lists them in one row.
      const [runbook, flaky] = SIDEBAR_FIXTURE.threads as [Session, Session];
      const runId = "01a06d02-d000-7000-8000-000000000001";
      const sessions = [
        onForge(runbook),
        onForge(flaky),
        onForge(runbook, {
          id: "01a06d02-b100-7000-8000-000000000001",
          kind: "run",
          runId,
          stepId: "plan",
        }),
        onForge(runbook, {
          id: "01a06d02-b100-7000-8000-000000000002",
          kind: "run",
          runId,
          stepId: "code",
        }),
      ];
      await openFleet({
        handlers: { "GET /api/v1/sessions": () => ({ body: { items: sessions } }) },
      });

      expect(
        within(getCard("forge")).getByRole("img", { name: "2 groups at work here" }),
      ).toBeTruthy();
      expect(within(getCard("atlas")).queryByRole("img", { name: /at work here/ })).toBeNull();
    });
  });

  describe("keeping the sessions current", () => {
    /** Counts the reads of the Fleet's session list in `calls` from `from` on: every status but exited, of every kind. */
    const countFleetReads = (calls: readonly Call[], from: number): number =>
      calls
        .slice(from)
        .filter(
          (call) =>
            call.method === "GET" &&
            call.path === "/api/v1/sessions" &&
            call.search.includes("status") &&
            !call.search.includes("kind"),
        ).length;

    /** Opens Fleet with a session list the test can change, once the live connection holds the `session` topic. */
    const openFleetWithLiveSessions = async () => {
      let served: readonly Session[] = SESSIONS;
      const app = await openFleet({
        handlers: { "GET /api/v1/sessions": () => ({ body: { items: served } }) },
      });
      await waitFor(() => expect(app.live.readTopics()).toContain("session"));
      await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
      await waitFor(() => expect(app.context.queryClient.isFetching()).toBe(0));
      return {
        ...app,
        serve: (next: readonly Session[]): void => {
          served = next;
        },
      };
    };

    it("reads the sessions again on a push and shows the new counts", async () => {
      const { calls, live, serve } = await openFleetWithLiveSessions();
      const before = calls.length;

      serve([...SESSIONS, buildSessionOn(FORGE, "busy"), buildSessionOn(FORGE, "busy")]);
      act(() => live.pushInvalidation("session"));

      await waitFor(() => expect(getValue(getCard("forge"), "4 of 16")).toBeTruthy());
      expect(countFleetReads(calls, before)).toBe(1);
    });

    it("reads nothing on a push while the window is hidden, and reads the sessions once when it shows", async () => {
      const { calls, live, serve, context } = await openFleetWithLiveSessions();
      const before = calls.length;

      setVisibility("hidden");
      serve([...SESSIONS, buildSessionOn(FORGE, "busy"), buildSessionOn(FORGE, "busy")]);
      act(() => live.pushInvalidation("session"));
      act(() => live.pushInvalidation("session"));
      await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
      await waitFor(() => expect(context.queryClient.isFetching()).toBe(0));

      expect(countFleetReads(calls, before)).toBe(0);
      expect(getValue(getCard("forge"), "2 of 16")).toBeTruthy();

      setVisibility("visible");

      await waitFor(() => expect(getValue(getCard("forge"), "4 of 16")).toBeTruthy());
      expect(countFleetReads(calls, before)).toBe(1);
    });
  });
});

describe("the Software section", () => {
  const CLAUDE_CODE: Harness = {
    ...HARNESSES.find((harness) => harness.id === "claude-code/claude-code")!,
    runners: [
      { runnerId: ATLAS.id, installed: true, version: "2.0.84", versionVerdict: "ok" },
      { runnerId: FORGE.id, installed: true, version: "2.0.78", versionVerdict: "ok" },
      { runnerId: NOMAD.id, installed: false, version: null, versionVerdict: "unknown" },
    ],
    latestRelease: { version: "2.0.84", checkedAt: "2026-11-02T09:00:00.000Z", error: null },
  };
  const ATLAS_WITH_GIT = {
    ...ATLAS,
    facts: { ...FACTS, toolchains: [{ name: "git", version: "2.50.1", path: "/usr/bin/git" }] },
  };

  const openSoftware = () =>
    openFleet({
      runners: [ATLAS_WITH_GIT, FORGE, NOMAD],
      handlers: { "GET /api/v1/harnesses": { body: [CLAUDE_CODE] } },
    });

  const getSoftwareTable = (): HTMLElement =>
    screen.getByRole("table", { name: "Software on each machine" });

  /** Returns the cells of the tool `name` after its Latest cell, as text, one per machine in the column order. */
  const readToolCells = (name: string): string[] => {
    const row = within(getSoftwareTable())
      .getAllByRole("row")
      .find((each) => within(each).queryByRole("button", { name }) !== null)!;
    return within(row)
      .getAllByRole("cell")
      .map((cell) => cell.textContent ?? "");
  };

  it("shows each tool against its latest release, on every machine", async () => {
    await openSoftware();

    const table = getSoftwareTable();
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((head) => head.textContent),
    ).toEqual(["Tool", "Latest", "atlas", "forge", "nomad"]);
    // Latest, then atlas (the latest, a check), forge (older), nomad (not installed).
    // A dash for a missing tool has "Not installed" as hidden text.
    expect(readToolCells("Claude Code")).toEqual([
      "2.0.84",
      "2.0.84",
      "2.0.78",
      "\u2013Not installed",
    ]);
    // A runner updates to its controller's version, which is also theirs.
    expect(readToolCells("Hercule runner")).toEqual(["0.9.3", "0.9.3", "0.9.3", "0.9.3"]);
    expect(readToolCells("git")).toEqual([
      "Not tracked",
      "2.50.1",
      "\u2013Not installed",
      "\u2013Not installed",
    ]);
  });

  it("opens a tool's detail under its row, with when its latest release was checked", async () => {
    const user = userEvent.setup();
    await openSoftware();

    await user.click(within(getSoftwareTable()).getByRole("button", { name: "Claude Code" }));

    const table = getSoftwareTable();
    expect(within(table).getByText("Runs Claude models.")).toBeTruthy();
    expect(within(table).getByText("Latest release 2.0.84, checked 09:00.")).toBeTruthy();
    expect([...table.querySelectorAll("dl > div")].map((group) => group.textContent)).toEqual([
      "2.0.84atlas",
      "2.0.78forge",
      "Not installednomad",
    ]);
  });

  it("opens a machine's page at its Software section from the machine's column head", async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
    const { router } = await openSoftware();

    await user.click(
      within(getSoftwareTable()).getByRole("button", { name: "Open forge at Software" }),
    );

    await screen.findByRole("heading", { level: 2, name: "forge" });
    expect(router.state.location.pathname).toBe(`/fleet/${FORGE.id}`);
    await waitFor(() =>
      expect(scrollIntoView.mock.contexts.map((element) => (element as Element).id)).toContain(
        MACHINE_SOFTWARE_ID,
      ),
    );
    scrollIntoView.mockRestore();
  });

  it("scrolls to the section from the Software jump link", async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
    await openSoftware();

    await user.click(
      within(screen.getByRole("navigation", { name: "Fleet" })).getByRole("button", {
        name: "Software",
      }),
    );

    expect(scrollIntoView.mock.contexts.map((element) => (element as Element).id)).toEqual([
      "software",
    ]);
    scrollIntoView.mockRestore();
  });
});
