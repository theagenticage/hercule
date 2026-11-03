/**
 * Tests a machine's page (spec 17 §Fleet, A machine's page): its head and
 * room line, the banner of a machine that is away, the Capacity section with
 * its instruments, the Running here section, the Software section, and the
 * Settings rows with their saves, refusals and Retire.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { queryKeys } from "@hercule/client-core";
import { HARNESSES } from "@hercule/client-core/testing";
import { PROBED_TOOLCHAINS } from "@hercule/contract";
import type {
  Assistant,
  Harness,
  ProviderAccount,
  Run,
  RunSummary,
  Runner,
  Session,
} from "@hercule/contract";
import { runWorkflowNameQuery } from "../../../../app/queries";
import {
  buildErrorBody,
  buildFixtureAssistant,
  buildFixtureAssistantSession,
  buildSidebarHandlers,
  changeTextSize,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_ACCOUNT,
  FIXTURE_THREAD_IDS,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  stubElementSize,
  stubIntersectionObserver,
  type Call,
  type Handler,
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

const GIB = 1024 ** 3;
const [MOSS_RECORD] = SIDEBAR_FIXTURE.runners;

/**
 * atlas: online, 16 GiB, a 500 GB disk with 100 GB free, a CPU at 23% (peak
 * 61%), a cap of 8, a 10 GiB disk limit, and the label gpu.
 */
const ATLAS: Runner = {
  ...MOSS_RECORD!,
  name: "atlas",
  connectivity: "online",
  lifecycle: "active",
  reserved: false,
  version: "0.9.3",
  labels: ["gpu"],
  facts: {
    os: "darwin",
    arch: "arm64",
    totalMemoryBytes: 16 * GIB,
    diskTotalBytes: 500_000_000_000,
    docker: false,
    toolchains: [],
    probedToolchains: PROBED_TOOLCHAINS,
    harnesses: [
      { name: "claude", present: true, path: "/usr/local/bin/claude" },
      { name: "codex", present: true, path: "/usr/local/bin/codex" },
    ],
    adapters: ["claude-code/claude-code", "codex/codex"],
    identityPort: 4939,
  },
  metrics: {
    diskFreeBytes: 100_000_000_000,
    availableMemoryBytes: 8 * GIB,
    cpu: { averagePercent: 23, peakPercent: 61 },
  },
  maxConcurrentSessions: 8,
  diskWatermarkBytes: 10 * GIB,
  lastSeenAt: "2026-11-02T09:12:00.000Z",
};

/** atlas as the controller returns it from an operation on one runner. */
const asDetail = (runner: Runner) => ({
  ...runner,
  negotiatedCapabilities: null,
  protocolVersion: null,
});

/** Claude Code is installed on atlas below the oldest supported version, Codex above the newest tested one, and pi is missing. */
const HARNESSES_ON_ATLAS: readonly Harness[] = HARNESSES.map((harness) => {
  const onAtlas = (version: string, versionVerdict: "below-floor" | "above-tested-max") => [
    { runnerId: ATLAS.id, installed: true, version, versionVerdict },
  ];
  if (harness.id === "claude-code/claude-code") {
    return { ...harness, runners: onAtlas("1.0.0", "below-floor") };
  }
  if (harness.id === "codex/codex") {
    return { ...harness, runners: onAtlas("9.9.9", "above-tested-max") };
  }
  return harness;
});

/** Anthropic: a subscription account that is not signed in on atlas. */
const ANTHROPIC_UNSIGNED: ProviderAccount = {
  ...FIXTURE_ACCOUNT,
  snapshots: [],
  readiness: [],
};

/** OpenAI: a subscription account signed in on atlas. */
const OPENAI_SIGNED_IN: ProviderAccount = {
  ...FIXTURE_ACCOUNT,
  id: "01a06d02-7600-7000-8000-000000000002",
  providerId: "openai/openai",
  defaultHarnessId: "codex/codex",
  readiness: [{ harnessId: "codex/codex", runnerId: ATLAS.id, state: "ready" }],
  snapshots: [
    {
      ...FIXTURE_ACCOUNT.snapshots[0]!,
      runnerId: ATLAS.id,
      harnessId: "codex/codex",
      auth: { status: "ok", identity: "rogier@openai.example", planLabel: "Plus" },
    },
  ],
};

/** Z.ai: an API key account, which works on every machine and has no sign-in. */
const ZAI_KEY: ProviderAccount = {
  ...FIXTURE_ACCOUNT,
  id: "01a06d02-7600-7000-8000-000000000003",
  providerId: "zai/zai",
  kind: "api-key",
  defaultHarnessId: "pi/pi",
  readiness: [],
  snapshots: [],
};

const buildControllerInfo = (version: string) => ({
  id: "01a06d02-7800-7000-8000-000000000001",
  publicKey: "controller-key",
  version,
  defaultRunnerId: null,
  localRunnerId: null,
  textGeneration: { model: null, lastFailure: null, unavailableReason: null },
});

const RUNNER_PATH = `/api/v1/runners/${ATLAS.id}`;

/**
 * Opens atlas's page. The controller holds the runner in `held.runner`, which
 * a PATCH, a drain, an undrain and a retire change as the real controller
 * does, so the page reads back what was saved. `overrides` replace any
 * answer.
 *
 * The sessions of the sidebar's fixture run on atlas. `extraSessions` are
 * more of them that are not threads or that no row lists, and `runs` are the
 * running runs, `assistants` the assistants the controller holds.
 */
const openMachine = async ({
  runner = ATLAS,
  controllerVersion = "0.9.4",
  extraSessions = [],
  runs = [],
  assistants = [],
  overrides = {},
}: {
  readonly runner?: Runner;
  readonly controllerVersion?: string;
  readonly extraSessions?: readonly Session[];
  readonly runs?: readonly RunSummary[];
  readonly assistants?: readonly Assistant[];
  readonly overrides?: Readonly<Record<string, Handler>>;
} = {}) => {
  const held = { runner };
  const sidebar = buildSidebarHandlers({
    ...SIDEBAR_FIXTURE,
    runners: [runner],
    accounts: [ANTHROPIC_UNSIGNED, OPENAI_SIGNED_IN, ZAI_KEY],
    runs,
    assistants: assistants.map((assistant) => ({ assistant, session: null })),
  });
  const answerSidebarSessions = sidebar["GET /api/v1/sessions"] as (call: Call) => {
    readonly body: { readonly items: readonly Session[] };
  };
  const change = (update: Partial<Runner>) => {
    held.runner = { ...held.runner, ...update };
    return { body: asDetail(held.runner) };
  };
  const calls = stubApi({
    ...sidebar,
    // The page reads the open sessions with no kind, unlike the sidebar's reads.
    "GET /api/v1/sessions": (call) => {
      const answer = answerSidebarSessions(call);
      const params = new URLSearchParams(call.search);
      const isFleetRead = ["kind", "runId", "conversationId"].every((name) => !params.has(name));
      return isFleetRead ? { body: { items: [...answer.body.items, ...extraSessions] } } : answer;
    },
    "GET /api/v1/runners": () => ({ body: { items: [held.runner] } }),
    "GET /api/v1/harnesses": { body: HARNESSES_ON_ATLAS },
    "GET /api/v1/controller": { body: buildControllerInfo(controllerVersion) },
    [`PATCH ${RUNNER_PATH}`]: (call) => change(call.body as Partial<Runner>),
    [`POST ${RUNNER_PATH}/drain`]: () => change({ lifecycle: "draining" }),
    [`POST ${RUNNER_PATH}/undrain`]: () => change({ lifecycle: "active" }),
    [`POST ${RUNNER_PATH}/retire`]: () => change({ lifecycle: "retired" }),
    ...overrides,
  });
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    { path: `/fleet/${runner.id}` },
  );
  await screen.findByRole("heading", { level: 2, name: runner.name });
  return { calls, ...app };
};

/** Returns the requests in `calls` with `method` to `path`. */
const readCalls = (calls: readonly Call[], method: string, path: string): readonly Call[] =>
  calls.filter((call) => call.method === method && call.path === path);

const getCapacity = () => screen.getByRole("region", { name: "Capacity" });
/** Returns the text of each instrument of the Capacity section, in the order drawn. */
const readInstruments = (): readonly string[] =>
  Array.from(
    getCapacity().querySelectorAll(".machine-page-instrument"),
    (tile) => tile.textContent,
  );
/** Returns the text of each piece after the status in a machine's head, in the order drawn. */
const readHeadPieces = (head: HTMLElement): readonly string[] =>
  Array.from(head.querySelectorAll(".machine-page-head-piece"), (piece) => piece.textContent);
const getSettings = () => screen.getByRole("region", { name: "Settings" });
const getSoftware = () => screen.getByRole("region", { name: "Software" });

describe("a machine's head", () => {
  it("shows the name, the status, what the runner reported, and the room line", async () => {
    await openMachine();

    const head = screen.getByRole("heading", { level: 2, name: "atlas" }).closest("header")!;
    expect(within(head).getByText("Online")).toBeTruthy();
    expect(readHeadPieces(head)).toEqual([
      "macOS",
      "arm64",
      "16 GB memory",
      "500 GB disk",
      "Runner 0.9.3",
      "update available",
    ]);
    const roomLine = screen.getByText(/^Room for/);
    expect(roomLine.textContent).toBe("Room for 4 more, under its cap of 8");
    expect(within(roomLine).getByText("4").tagName).toBe("B");
  });

  it("names the state of a machine that takes no new work, in the head and in the room line", async () => {
    await openMachine({ runner: { ...ATLAS, lifecycle: "draining" } });

    const head = screen.getByRole("heading", { level: 2, name: "atlas" }).closest("header")!;
    expect(within(head).getByText("Takes no new work")).toBeTruthy();
    expect(screen.getByText("No room: it takes no new work")).toBeTruthy();
  });

  it("shows no update hint when the runner runs the controller's release", async () => {
    await openMachine({ controllerVersion: "0.9.3" });

    expect(screen.queryByText("update available")).toBeNull();
  });
});

describe("the Capacity section", () => {
  it("holds the room line and the three instruments of the machine, with their latest values", async () => {
    await openMachine();

    expect(within(getCapacity()).getByText(/^Room for/).textContent).toBe(
      "Room for 4 more, under its cap of 8",
    );
    expect(readInstruments()).toEqual([
      "Sessions4 of 8None waiting",
      "CPU23%Peak 61% in the last minute",
      "Memory50%8.0 GB free of 16 GB",
    ]);
  });

  it("is the first jump link of the header, scrolls to the section and lights while it is in view", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    await openMachine();

    const links = within(screen.getByRole("navigation", { name: "Fleet" })).getAllByRole("button");
    expect(links.map((link) => link.textContent)).toEqual([
      "Capacity",
      "Running",
      "Software",
      "Recent",
      "Settings",
    ]);
    expect(links[0]!.getAttribute("aria-current")).toBe("location");

    await userEvent.click(links[0]!);

    expect(scrollIntoView.mock.contexts).toEqual([getCapacity()]);
  });

  it("tells the instrument a runner cannot report, instead of leaving it blank", async () => {
    // An older runner leaves out the CPU altogether.
    await openMachine({
      runner: {
        ...ATLAS,
        facts: {
          os: "darwin",
          arch: "arm64",
          totalMemoryBytes: 16 * GIB,
          docker: false,
          toolchains: [],
          harnesses: [],
          adapters: [],
          identityPort: 4939,
        },
        metrics: { diskFreeBytes: 100_000_000_000, availableMemoryBytes: 8 * GIB },
      },
    });

    expect(readInstruments()).toEqual([
      "Sessions4 of 8None waiting",
      "CPU–This machine's runner is too old to report CPU. Update it.",
      "Memory50%8.0 GB free of 16 GB",
    ]);
  });
});

describe("the Running here section", () => {
  const LIVE_RUN_ID = "01a06d02-9000-7000-8000-000000000001";
  const ENDED_RUN_ID = "01a06d02-9000-7000-8000-000000000002";
  const ADA = buildFixtureAssistant({
    id: "01a06d02-a000-7000-8000-000000000002",
    name: "Ada",
    mainConversationId: "01a06d02-c000-7000-8000-000000000002",
  });
  /** Twelve minutes before the test's now. */
  const STARTED_AT = "2026-11-02T13:48:00.000Z";
  const STEP_AGENT_ID = "01a06d02-7b00-7000-8000-000000000001";

  /** Returns a session on atlas that no row lists. */
  const buildExtra = (id: string, over: Partial<Session>): Session => ({
    ...SIDEBAR_FIXTURE.threads[0]!,
    id,
    workspaceId: null,
    openRequests: [],
    status: "busy",
    createdAt: STARTED_AT,
    startedAt: STARTED_AT,
    ...over,
  });
  const buildStep = (id: string, runId: string): Session =>
    buildExtra(id, {
      kind: "run",
      runId,
      stepId: "review",
      agentId: STEP_AGENT_ID,
      title: "Review the main branch",
    });

  /** The step of the running run, the step of a run that ended, and Ada's conversation. */
  const STEP = buildStep("01a06d02-b200-7000-8000-000000000001", LIVE_RUN_ID);
  const ENDED_STEP = buildStep("01a06d02-b200-7000-8000-000000000002", ENDED_RUN_ID);
  const ADA_SESSION = buildFixtureAssistantSession(ADA, {
    id: "01a06d02-b200-7000-8000-000000000003",
    status: "busy",
    startedAt: STARTED_AT,
  });
  /** A Thread that waits for a free slot: it was created after the others started. */
  const QUEUED = buildExtra("01a06d02-b200-7000-8000-000000000004", {
    kind: "thread",
    title: "Port the importer",
    status: "queued",
    startedAt: null,
  });

  const LIVE_RUN: RunSummary = {
    id: LIVE_RUN_ID,
    workflowId: "01a06d02-7800-7000-8000-000000000001",
    workflowName: "Nightly review",
    origin: { kind: "manual", actor: "user" },
    createdAt: "2026-11-02T13:40:00.000Z",
    status: "running",
    startedAt: "2026-11-02T13:41:00.000Z",
    activeStepIds: ["review"],
    awaitedSignalIds: [],
  };
  /** A run as `run.read` returns it. Only its plan's name matters here. */
  const buildRunRecord = (id: string, name: string): Run => ({
    id,
    workflowId: "01a06d02-7800-7000-8000-000000000001",
    plan: {
      name,
      inputs: [],
      triggers: [],
      steps: [{ id: "clean", kind: "action", action: "github/pr.create" }],
      edges: [],
    },
    inputs: {},
    origin: { kind: "manual", actor: "user" },
    runnerId: ATLAS.id,
    subscriptions: [],
    createdAt: "2026-11-02T13:00:00.000Z",
    status: "completed",
    startedAt: "2026-11-02T13:01:00.000Z",
    finishedAt: "2026-11-02T13:30:00.000Z",
    steps: [],
    edgeTraversals: [],
  });

  const WORLD = {
    extraSessions: [STEP, ENDED_STEP, ADA_SESSION, QUEUED],
    runs: [LIVE_RUN],
    assistants: [ADA],
    overrides: {
      [`GET /api/v1/runs/${LIVE_RUN_ID}`]: { body: buildRunRecord(LIVE_RUN_ID, "Nightly review") },
      [`GET /api/v1/runs/${ENDED_RUN_ID}`]: { body: buildRunRecord(ENDED_RUN_ID, "Old cleanup") },
    },
  } as const;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const getWork = () => screen.getByRole("region", { name: "Running here" });
  /** Returns the text of each row or item the section lists, in order. */
  const readItems = (): readonly string[] =>
    within(getWork())
      .queryAllByRole("link")
      .map((link) => link.textContent);

  it("sits between Capacity and Software and groups the work into rows, those that wait for a slot first", async () => {
    const { calls } = await openMachine(WORLD);

    const work = getWork();
    expect(getCapacity().compareDocumentPosition(work) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
      0,
    );
    expect(work.compareDocumentPosition(getSoftware()) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
      0,
    );
    expect(readItems()).toEqual([
      "Port the importerThread · 1 waits for a slotsince 13:48",
      "Sketch the pricing pageThread · 1 idlesince 10 Sep 09:00",
      "Bump the Bun pinThread · 1 idlesince 10 Sep 09:00",
      "Fix flaky webhook testsThreads · Write the retry runbook · 1 working · 1 waits for yousince 10 Sep 09:00",
      "AdaAssistant · 1 workingsince 13:48",
      "Nightly reviewWorkflow run · review · 1 workingsince 13:48",
      "Old cleanupWorkflow run · review · 1 workingsince 13:48",
    ]);
    // Each run is named by its own record, which the loader read once.
    expect(readCalls(calls, "GET", `/api/v1/runs/${LIVE_RUN_ID}`)).toHaveLength(1);
    expect(readCalls(calls, "GET", `/api/v1/runs/${ENDED_RUN_ID}`)).toHaveLength(1);
  });

  it("reads a run's name once: a run push marks the run lists out of date but not the names, and renames nothing", async () => {
    const { calls, live, context } = await openMachine(WORLD);
    const { client } = context.controller!;
    const runList = queryKeys.runs({ status: "running" });
    context.queryClient.setQueryData(runList, []);

    // The shell subscribes to the run topic once the connection is up, so the push waits for it.
    await waitFor(() => {
      act(() => live.pushInvalidation("run", [LIVE_RUN_ID, ENDED_RUN_ID]));
    });

    // The push reached the run lists, so it would have reached the names if they sat under them.
    expect(context.queryClient.getQueryState(runList)?.isInvalidated).toBe(true);
    for (const runId of [LIVE_RUN_ID, ENDED_RUN_ID]) {
      const { queryKey } = runWorkflowNameQuery(client, runId);
      expect(context.queryClient.getQueryState(queryKey)?.isInvalidated).toBe(false);
      expect(readCalls(calls, "GET", `/api/v1/runs/${runId}`)).toHaveLength(1);
    }
    expect(readItems()).toContain("Nightly reviewWorkflow run · review · 1 workingsince 13:48");
    expect(readItems()).toContain("Old cleanupWorkflow run · review · 1 workingsince 13:48");
  });

  it("names a run by its session's title when the read of its name fails, and still draws the page", async () => {
    await openMachine({
      ...WORLD,
      overrides: {
        ...WORLD.overrides,
        [`GET /api/v1/runs/${ENDED_RUN_ID}`]: {
          status: 500,
          body: buildErrorBody("internal", "the controller failed"),
        },
      },
    });

    expect(readItems()).toEqual([
      expect.stringContaining("Port the importer"),
      expect.stringContaining("Sketch the pricing page"),
      expect.stringContaining("Bump the Bun pin"),
      expect.stringContaining("Fix flaky webhook tests"),
      expect.stringContaining("Ada"),
      "Nightly reviewWorkflow run · review · 1 workingsince 13:48",
      "Review the main branchWorkflow run · review · 1 workingsince 13:48",
    ]);
  });

  it("draws at most 12 faces in a row, then how many more, in a label a screen reader hears", async () => {
    const steps = Array.from({ length: 14 }, (_, index) =>
      buildStep(`01a06d02-b400-7000-8000-${String(index).padStart(12, "0")}`, LIVE_RUN_ID),
    );
    await openMachine({ ...WORLD, extraSessions: [...WORLD.extraSessions, ...steps] });

    const faces = within(getWork()).getByRole("img", { name: "15 sessions at work here" });
    expect(faces.querySelectorAll("svg")).toHaveLength(12);
    expect(faces.textContent).toBe("+3");
  });

  it("lists the sessions in the Sessions view, those that wait for a slot first, and goes back to Work", async () => {
    await openMachine(WORLD);

    await userEvent.click(within(getWork()).getByRole("button", { name: "Sessions" }));

    expect(readItems()).toEqual([
      "Port the importerWaits for a slot12m",
      "Sketch the pricing pageIdle7w",
      "Bump the Bun pinIdle7w",
      "Fix flaky webhook testsWorking7w",
      "Write the retry runbookWaits for you7w",
      "AdaWorking12m",
      "Review the main branchWorking12m",
      "Review the main branchWorking12m",
    ]);
    expect(
      within(getWork()).getByRole("button", { name: "Sessions" }).getAttribute("aria-pressed"),
    ).toBe("true");

    await userEvent.click(within(getWork()).getByRole("button", { name: "Work" }));

    expect(readItems()).toHaveLength(7);
  });

  it("shows the first 10 groups and the first 20 sessions, and Show all opens each view on its own", async () => {
    // The fixture's four sessions make three groups. Twenty more Threads, each
    // in a group of its own, make 23 groups and 24 sessions.
    const threads = Array.from({ length: 20 }, (_, index) =>
      buildExtra(`01a06d02-b300-7000-8000-${String(index).padStart(12, "0")}`, {
        kind: "thread",
        title: `Thread ${String(index)}`,
      }),
    );
    // A list that measures 2000px tall mounts every row of these lists.
    stubElementSize(900, 2000);
    await openMachine({ extraSessions: threads });

    expect(readItems()).toHaveLength(10);
    await userEvent.click(within(getWork()).getByRole("button", { name: "Show all 23" }));
    expect(readItems()).toHaveLength(23);
    expect(within(getWork()).getByRole("button", { name: "Show fewer" })).toBeTruthy();

    await userEvent.click(within(getWork()).getByRole("button", { name: "Sessions" }));
    expect(readItems()).toHaveLength(20);
    expect(within(getWork()).getByRole("button", { name: "Show all 24" })).toBeTruthy();

    await userEvent.click(within(getWork()).getByRole("button", { name: "Work" }));
    expect(readItems()).toHaveLength(23);
    await userEvent.click(within(getWork()).getByRole("button", { name: "Show fewer" }));
    expect(readItems()).toHaveLength(10);
  });

  it("says that nothing runs here, with no switch, when the machine has no open session", async () => {
    await openMachine({
      overrides: { "GET /api/v1/sessions": { body: { items: [] } } },
    });

    expect(within(getWork()).getByText("Nothing runs here right now.")).toBeTruthy();
    expect(within(getWork()).queryByRole("group")).toBeNull();
  });

  it("opens a Thread's row, a run and an assistant from their rows", async () => {
    const { router } = await openMachine(WORLD);

    await userEvent.click(within(getWork()).getByRole("link", { name: /^Port the importer/ }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/threads/${QUEUED.id}`);
    });
    await router.navigate({ to: "/fleet/$runnerId", params: { runnerId: ATLAS.id } });

    await userEvent.click(
      await within(await screen.findByRole("region", { name: "Running here" })).findByRole("link", {
        name: /^Nightly review/,
      }),
    );
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/runs/${LIVE_RUN_ID}`);
    });
    await router.navigate({ to: "/fleet/$runnerId", params: { runnerId: ATLAS.id } });

    await userEvent.click(
      await within(await screen.findByRole("region", { name: "Running here" })).findByRole("link", {
        name: /^Ada/,
      }),
    );
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/assistants/${ADA.id}`);
    });
  });

  it("opens the lead's Thread from a row of several sessions, and a Thread from a session of the Sessions view", async () => {
    const { router } = await openMachine(WORLD);

    await userEvent.click(
      within(getWork()).getByRole("link", { name: /^Fix flaky webhook tests/ }),
    );
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/threads/${FIXTURE_THREAD_IDS.flaky}`);
    });
    await router.navigate({ to: "/fleet/$runnerId", params: { runnerId: ATLAS.id } });

    const work = await screen.findByRole("region", { name: "Running here" });
    await userEvent.click(within(work).getByRole("button", { name: "Sessions" }));
    await userEvent.click(within(work).getByRole("link", { name: /^Bump the Bun pin/ }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/threads/${FIXTURE_THREAD_IDS.bunPin}`);
    });
  });

  describe("after Show all", () => {
    /** Sixty Threads, each in a group of its own, and the fixture's three groups. */
    const buildThreads = () =>
      Array.from({ length: 60 }, (_, index) =>
        buildExtra(`01a06d02-b300-7000-8000-${String(index).padStart(12, "0")}`, {
          kind: "thread",
          title: `Thread ${String(index)}`,
        }),
      );

    it("mounts only the rows near the visible part and reaches the others by scrolling, from the top again after Show fewer", async () => {
      // The list measures itself: 400px tall shows seven 54px rows.
      stubElementSize(900, 400);
      await openMachine({ extraSessions: buildThreads() });
      await userEvent.click(within(getWork()).getByRole("button", { name: "Show all 63" }));

      const list = within(getWork()).getByRole("navigation", { name: "All the work running here" });
      const mounted = within(list).getAllByRole("link");
      expect(mounted.length).toBeGreaterThan(5);
      expect(mounted.length).toBeLessThan(30);
      expect(within(list).queryByRole("link", { name: /^Thread 59/ })).toBeNull();

      act(() => {
        list.scrollTop = 63 * 54;
        fireEvent.scroll(list);
      });
      expect(await within(list).findByRole("link", { name: /^Thread 59/ })).toBeTruthy();
      expect(within(list).queryByRole("link", { name: /^Thread 0\b/ })).toBeNull();

      await userEvent.click(within(getWork()).getByRole("button", { name: "Show fewer" }));
      expect(within(getWork()).queryByRole("navigation")).toBeNull();
      await userEvent.click(within(getWork()).getByRole("button", { name: "Show all 63" }));
      const again = within(getWork()).getByRole("navigation", {
        name: "All the work running here",
      });
      expect(again.scrollTop).toBe(0);
    });

    it("lists the sessions in one column the same way, and each view starts at the top", async () => {
      stubElementSize(900, 400);
      await openMachine({ extraSessions: buildThreads() });
      await userEvent.click(within(getWork()).getByRole("button", { name: "Sessions" }));
      await userEvent.click(within(getWork()).getByRole("button", { name: "Show all 64" }));

      const list = within(getWork()).getByRole("navigation", {
        name: "All the sessions running here",
      });
      expect(within(list).getAllByRole("link").length).toBeLessThan(30);
      act(() => {
        list.scrollTop = 64 * 46;
        fireEvent.scroll(list);
      });
      expect(await within(list).findByRole("link", { name: /^Thread 59/ })).toBeTruthy();

      await userEvent.click(within(getWork()).getByRole("button", { name: "Work" }));
      expect(
        within(getWork()).queryByRole("navigation", { name: "All the sessions running here" }),
      ).toBeNull();
    });

    it("places the rows by heights that follow the Text size", async () => {
      stubElementSize(900, 400);
      await openMachine({ extraSessions: buildThreads() });
      await userEvent.click(within(getWork()).getByRole("button", { name: "Show all 63" }));
      const list = within(getWork()).getByRole("navigation", { name: "All the work running here" });
      const items = list.querySelector<HTMLElement>(".virtual-list-items")!;
      expect(items.style.height).toBe(`${String(63 * 54)}px`);

      await changeTextSize(3, { "--fleet-running-height-work": "58px" });

      await waitFor(() => {
        expect(items.style.height).toBe(`${String(63 * 58)}px`);
      });
    });

    it("keeps keyboard focus in the list: Tab reaches a row, and the row stays focused", async () => {
      stubElementSize(900, 400);
      await openMachine({ extraSessions: buildThreads() });
      await userEvent.click(within(getWork()).getByRole("button", { name: "Show all 63" }));
      const list = within(getWork()).getByRole("navigation", { name: "All the work running here" });

      const first = within(list).getAllByRole("link")[0]!;
      first.focus();
      expect(document.activeElement).toBe(first);
      act(() => {
        list.scrollTop = 63 * 54;
        fireEvent.scroll(list);
      });
      // The focused row stays mounted though it is far above the visible part.
      expect(document.activeElement).toBe(first);
      expect(list.contains(first)).toBe(true);
    });
  });
});

describe("a machine that is away", () => {
  const OFFLINE: Runner = { ...ATLAS, connectivity: "offline" };

  it("shows the banner in place of the room line, with the command to start it again", async () => {
    await openMachine({ runner: OFFLINE });

    // Four threads of atlas have not exited; the fifth has.
    const banner = screen.getByText(/^atlas has not been heard from since 09:12\./).closest("div")!;
    expect(banner.textContent).toBe(
      "atlas has not been heard from since 09:12.It may be asleep, off the network, or without power. Its 4 threads can carry on once it is back, and work waiting for it starts then. If it does not come back by itself, start Hercule on it again: hercule service start. What you see below is from 09:12.",
    );
    expect(within(banner).getByText("hercule service start").tagName).toBe("CODE");
    expect(screen.queryByText(/^Room for/)).toBeNull();
    expect(
      screen.getByRole("heading", { level: 2, name: "atlas" }).closest("header")!.textContent,
    ).toContain("Offline");
  });

  it("keeps the instruments below the banner, with the values it last reported", async () => {
    await openMachine({ runner: OFFLINE });

    expect(within(getCapacity()).queryByText(/has not been heard from/)).toBeNull();
    expect(readInstruments()).toEqual([
      "Sessions– of 8None waiting",
      "CPU23%Peak 61% in the last minute",
      "Memory50%8.0 GB free of 16 GB",
    ]);
  });

  it("shows the time in the user's time zone from the settings, as the Fleet page does", async () => {
    await openMachine({
      runner: OFFLINE,
      overrides: {
        "GET /api/v1/settings": { body: { controller: {}, user: { timezone: "Asia/Tokyo" } } },
      },
    });

    // The browser's zone is UTC here, where the runner was last heard from at 09:12.
    expect(screen.getByText(/^atlas has not been heard from since 18:12\./)).toBeTruthy();
  });

  it("asks the same retire question from the banner as from Settings", async () => {
    const { calls } = await openMachine({ runner: OFFLINE });

    const [fromBanner] = screen.getAllByRole("button", { name: "Retire…" });
    await userEvent.click(fromBanner!);

    const dialog = await screen.findByRole("dialog", { name: "Retire atlas?" });
    expect(within(dialog).getByRole("button", { name: "Retire" })).toBeTruthy();
    expect(readCalls(calls, "POST", `${RUNNER_PATH}/retire`)).toHaveLength(0);
  });

  it("offers no Sign in on the machine", async () => {
    await openMachine({ runner: OFFLINE });

    expect(within(getSoftware()).queryByRole("button", { name: /^Sign in/ })).toBeNull();
  });
});

describe("a machine that is retired while its page is open", () => {
  it("shows that the machine was not found, with a link to Fleet that lists no card for it", async () => {
    const user = userEvent.setup();
    const FORGE: Runner = { ...ATLAS, id: "01a06d02-a000-7000-8000-000000000002", name: "forge" };
    let served: readonly Runner[] = [ATLAS, FORGE];
    const { live, router } = await openMachine({
      overrides: { "GET /api/v1/runners": () => ({ body: { items: served } }) },
    });

    await waitFor(() => expect(live.readTopics()).toContain("runner"));
    served = [{ ...ATLAS, lifecycle: "retired" }, FORGE];
    act(() => live.pushInvalidation("runner", [ATLAS.id]));

    const headline = await screen.findByRole("heading", { name: "This machine was not found." });
    // The header's crumb and the sidebar link to Fleet too; this is the link of the screen itself.
    await user.click(within(headline.parentElement!).getByRole("link", { name: "Fleet" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/fleet"));
    expect(await screen.findByRole("button", { name: "forge" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "atlas" })).toBeNull();
  });
});

describe("the Software section", () => {
  it("lists each harness with its version and what the version means for this Hercule", async () => {
    await openMachine();

    const rows = within(within(getSoftware()).getByRole("list", { name: "Harnesses" }))
      .getAllByRole("listitem")
      .map((row) => row.textContent);
    expect(rows.slice(0, 2)).toEqual([
      "Claude Code1.0.0Too old for this Hercule: update it",
      "Codex9.9.9Newer than this Hercule was tested with",
    ]);
    // pi has no logo, so its mark is the character π before the name.
    expect(rows[2]).toMatch(/piNot installed$/);
    expect(rows).toHaveLength(3);
    expect(within(getSoftware()).queryByRole("button", { name: /Install|Update/ })).toBeNull();
  });

  it("lists the accounts that sign in on each machine, and leaves out a key account", async () => {
    await openMachine();

    const rows = within(
      within(getSoftware()).getByRole("list", { name: "Accounts signed in here" }),
    )
      .getAllByRole("listitem")
      .map((row) => row.textContent);
    expect(rows).toEqual([
      "AnthropicClaude CodeNot signed inSign in",
      "OpenAICodexSigned in as rogier@openai.example",
    ]);
  });

  it("lists the tools found on the machine in the order the runner reported them, then names the ones that are missing", async () => {
    await openMachine({
      runner: {
        ...ATLAS,
        facts: {
          ...ATLAS.facts!,
          toolchains: [
            { name: "node", version: "22.11.0", path: "/usr/local/bin/node" },
            { name: "git", version: "2.47.0", path: "/usr/bin/git" },
          ],
        },
      },
    });

    const tools = within(getSoftware()).getByRole("list", { name: "Tools" });
    expect(
      within(tools)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual(["node22.11.0", "git2.47.0"]);
    expect(within(getSoftware()).getByText(/^Not installed: gh, /).textContent).not.toMatch(
      /git|node/,
    );
  });

  it("says which tools an older runner did not look for, apart from the ones it found missing", async () => {
    // An older runner sends no list of what it looked for.
    const olderFacts = Object.fromEntries(
      Object.entries(ATLAS.facts!).filter(([key]) => key !== "probedToolchains"),
    ) as NonNullable<Runner["facts"]>;
    await openMachine({ runner: { ...ATLAS, facts: olderFacts } });

    const software = getSoftware();
    expect(within(software).getByText("Not installed: git, gh")).toBeTruthy();
    expect(
      within(software).getByText(/^This runner is too old to look for node, pnpm, /),
    ).toBeTruthy();
  });

  it("names every probed tool as not installed when the runner found none", async () => {
    await openMachine();

    const software = getSoftware();
    expect(within(software).queryByRole("list", { name: "Tools" })).toBeNull();
    expect(within(software).getByRole("heading", { name: "Tools" })).toBeTruthy();
    expect(within(software).getByText(/^Not installed: git, gh, node, /)).toBeTruthy();
  });

  it("says nothing about tools while the runner has not reported its facts", async () => {
    await openMachine({ runner: { ...ATLAS, facts: null } });

    expect(within(getSoftware()).queryByRole("heading", { name: "Tools" })).toBeNull();
    expect(within(getSoftware()).queryByText(/^Not installed:/)).toBeNull();
  });

  it("opens the account's sign-in dialog for this machine from Sign in", async () => {
    const { calls } = await openMachine({
      overrides: {
        [`POST /api/v1/provider-accounts/${ANTHROPIC_UNSIGNED.id}/sign-in`]: {
          body: { url: "https://claude.ai/oauth/authorize?code=1" },
        },
      },
    });

    await userEvent.click(
      within(getSoftware()).getByRole("button", { name: "Sign in to Anthropic" }),
    );

    expect(
      await screen.findByRole("dialog", { name: "Sign in to Anthropic on atlas" }),
    ).toBeTruthy();
    expect(
      readCalls(calls, "POST", `/api/v1/provider-accounts/${ANTHROPIC_UNSIGNED.id}/sign-in`),
    ).toHaveLength(1);
  });
});

describe("the Settings section", () => {
  it("saves the session cap, and refuses text that is not a whole number of 1 or more", async () => {
    const { calls } = await openMachine();
    const field = within(getSettings()).getByRole("textbox", { name: "Session cap" });

    await userEvent.clear(field);
    await userEvent.type(field, "0{Enter}");

    expect((await within(getSettings()).findByRole("alert")).textContent).toBe(
      "The session cap must be a whole number of 1 or more, such as 8.",
    );
    expect((field as HTMLInputElement).value).toBe("8");
    expect(readCalls(calls, "PATCH", RUNNER_PATH)).toHaveLength(0);

    await userEvent.type(field, "{Backspace}12{Enter}");

    await waitFor(() => {
      expect(readCalls(calls, "PATCH", RUNNER_PATH).map((call) => call.body)).toEqual([
        { maxConcurrentSessions: 12 },
      ]);
    });
    await waitFor(() => {
      expect(within(getSettings()).queryByRole("alert")).toBeNull();
    });
    expect((field as HTMLInputElement).value).toBe("12");
  });

  it("adds a label, removes one, and refuses a label it has", async () => {
    const { calls } = await openMachine();

    await userEvent.click(within(getSettings()).getByRole("button", { name: "Add a label" }));
    await userEvent.type(screen.getByRole("textbox", { name: "New label" }), "  fast {Enter}");
    await waitFor(() => {
      expect(readCalls(calls, "PATCH", RUNNER_PATH).map((call) => call.body)).toEqual([
        { labels: ["gpu", "fast"] },
      ]);
    });
    await within(getSettings()).findByText("fast");

    await userEvent.click(
      within(getSettings()).getByRole("button", { name: "Remove the label gpu" }),
    );
    await waitFor(() => {
      expect(readCalls(calls, "PATCH", RUNNER_PATH).map((call) => call.body)).toEqual([
        { labels: ["gpu", "fast"] },
        { labels: ["fast"] },
      ]);
    });

    await userEvent.click(within(getSettings()).getByRole("button", { name: "Add a label" }));
    await userEvent.type(screen.getByRole("textbox", { name: "New label" }), "fast{Enter}");
    expect((await within(getSettings()).findByRole("alert")).textContent).toBe(
      'This machine already has the label "fast".',
    );
    expect(readCalls(calls, "PATCH", RUNNER_PATH)).toHaveLength(2);
  });

  it("refuses a label of more than 64 characters", async () => {
    const { calls } = await openMachine();

    await userEvent.click(within(getSettings()).getByRole("button", { name: "Add a label" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "New label" }),
      `${"a".repeat(65)}{Enter}`,
    );

    expect((await within(getSettings()).findByRole("alert")).textContent).toMatch(
      /^A label can have at most 64 characters\./,
    );
    expect(readCalls(calls, "PATCH", RUNNER_PATH)).toHaveLength(0);
  });

  it("saves the Reserved switch", async () => {
    const { calls } = await openMachine();

    await userEvent.click(within(getSettings()).getByRole("switch", { name: "Reserved" }));

    await waitFor(() => {
      expect(readCalls(calls, "PATCH", RUNNER_PATH).map((call) => call.body)).toEqual([
        { reserved: true },
      ]);
    });
    await waitFor(() => {
      expect(
        within(getSettings())
          .getByRole("switch", { name: "Reserved" })
          .getAttribute("aria-checked"),
      ).toBe("true");
    });
  });

  it("puts the switch back and says why when a save is refused", async () => {
    await openMachine({
      overrides: {
        [`PATCH ${RUNNER_PATH}`]: {
          status: 409,
          body: buildErrorBody("conflict", "another change got there first"),
        },
      },
    });

    await userEvent.click(within(getSettings()).getByRole("switch", { name: "Reserved" }));

    expect((await within(getSettings()).findByRole("alert")).textContent).toBe(
      "Could not save: another change got there first",
    );
    expect(
      within(getSettings()).getByRole("switch", { name: "Reserved" }).getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("shows the disk limit in gigabytes and saves a changed one", async () => {
    const { calls } = await openMachine();
    const field = within(getSettings()).getByRole("textbox", { name: "Disk limit" });
    // 10 GiB is 10.737 GB.
    expect((field as HTMLInputElement).value).toBe("10.7");

    await userEvent.clear(field);
    await userEvent.type(field, "20{Enter}");

    await waitFor(() => {
      expect(readCalls(calls, "PATCH", RUNNER_PATH).map((call) => call.body)).toEqual([
        { diskWatermarkBytes: 20_000_000_000 },
      ]);
    });
  });

  it("does not rewrite the stored disk limit when the text is back to what it showed", async () => {
    const { calls } = await openMachine();
    const field = within(getSettings()).getByRole("textbox", { name: "Disk limit" });

    // The text ends as it began, so rounding "10.7" back to bytes would change the stored 10 GiB.
    await userEvent.type(field, "{Backspace}7");
    await userEvent.tab();

    expect((field as HTMLInputElement).value).toBe("10.7");
    expect(readCalls(calls, "PATCH", RUNNER_PATH)).toHaveLength(0);
  });

  it("refuses a disk limit with two decimals", async () => {
    const { calls } = await openMachine();
    const field = within(getSettings()).getByRole("textbox", { name: "Disk limit" });

    await userEvent.clear(field);
    await userEvent.type(field, "1.25{Enter}");

    expect((await within(getSettings()).findByRole("alert")).textContent).toMatch(
      /^The disk limit must be a number of gigabytes/,
    );
    expect(readCalls(calls, "PATCH", RUNNER_PATH)).toHaveLength(0);
  });

  it("stops new work with drain, and takes new work again with undrain", async () => {
    const { calls } = await openMachine();

    await userEvent.click(within(getSettings()).getByRole("switch", { name: "Stop new work" }));

    await waitFor(() => {
      expect(
        within(getSettings())
          .getByRole("switch", { name: "Stop new work" })
          .getAttribute("aria-checked"),
      ).toBe("true");
    });
    expect(readCalls(calls, "POST", `${RUNNER_PATH}/drain`)).toHaveLength(1);
    expect(screen.getByText("No room: it takes no new work")).toBeTruthy();

    await userEvent.click(within(getSettings()).getByRole("switch", { name: "Stop new work" }));

    await waitFor(() => {
      expect(
        within(getSettings())
          .getByRole("switch", { name: "Stop new work" })
          .getAttribute("aria-checked"),
      ).toBe("false");
    });
    expect(readCalls(calls, "POST", `${RUNNER_PATH}/undrain`)).toHaveLength(1);
  });

  it("puts Stop new work back and says why when the controller refuses", async () => {
    await openMachine({
      overrides: {
        [`POST ${RUNNER_PATH}/drain`]: {
          status: 409,
          body: buildErrorBody("invalid_state", "atlas is being retired"),
        },
      },
    });

    await userEvent.click(within(getSettings()).getByRole("switch", { name: "Stop new work" }));

    expect((await within(getSettings()).findByRole("alert")).textContent).toBe(
      "Could not save: atlas is being retired",
    );
    expect(
      within(getSettings())
        .getByRole("switch", { name: "Stop new work" })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });
});

describe("Retire", () => {
  it("asks first, then retires the machine and goes to Fleet", async () => {
    const { calls, router } = await openMachine();

    await userEvent.click(within(getSettings()).getByRole("button", { name: "Retire…" }));
    const dialog = await screen.findByRole("dialog", { name: "Retire atlas?" });
    expect(readCalls(calls, "POST", `${RUNNER_PATH}/retire`)).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole("button", { name: "Retire" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/fleet");
    });
    expect(readCalls(calls, "POST", `${RUNNER_PATH}/retire`).map((call) => call.body)).toEqual([
      {},
    ]);
  });

  it("forces the retire of an unreachable machine and says so", async () => {
    const { calls } = await openMachine({ runner: { ...ATLAS, connectivity: "unreachable" } });

    await userEvent.click(within(getSettings()).getByRole("button", { name: "Retire…" }));
    const dialog = await screen.findByRole("dialog", { name: "Retire atlas?" });
    expect(
      within(dialog).getByText("This runner is unreachable; retiring it now forces it."),
    ).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Retire" }));

    await waitFor(() => {
      expect(readCalls(calls, "POST", `${RUNNER_PATH}/retire`).map((call) => call.body)).toEqual([
        { force: true },
      ]);
    });
  });

  it("shows the controller's refusal in the dialog and stays on the page", async () => {
    const { router } = await openMachine({
      overrides: {
        [`POST ${RUNNER_PATH}/retire`]: {
          status: 409,
          body: buildErrorBody("invalid_state", "atlas still has a session starting"),
        },
      },
    });

    await userEvent.click(within(getSettings()).getByRole("button", { name: "Retire…" }));
    const dialog = await screen.findByRole("dialog", { name: "Retire atlas?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Retire" }));

    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "atlas still has a session starting",
    );
    expect(within(dialog).queryByRole("button", { name: "Retire" })).toBeNull();
    expect(router.state.location.pathname).toBe(`/fleet/${ATLAS.id}`);
  });
});
