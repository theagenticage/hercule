/**
 * The board, the fixtures and the helpers that the Work screen's integration
 * tests share (`work.integration.test.tsx`, `work.pane`, `work.answers` and
 * `work.actions`): the Tasks the controller answers with, opening the app at
 * Work, the details of a Task, the shortened undo window, and the board
 * grouped by repository.
 */
import { vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { buildBoard, buildCard, buildPlace } from "@hercule/client-core/work/testing";
import type { PluginDetail, Task, TaskDetail, WorkBoard, WorkCard } from "@hercule/contract";
import {
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  type Call,
  type Handler,
} from "../../../app/testing";
import { UNDO_WINDOW_MS } from "../../../app/pending-intents";
import type { DesktopPlatform } from "../../../../ipc/platform/desktop-platform";

export const WEBSHOP = SIDEBAR_FIXTURE.projects[0]!;
export const OPS = SIDEBAR_FIXTURE.projects[1]!;

/** Returns a valid id for the Task or session numbered `n`. */
export const buildTaskId = (n: number): string =>
  `01a06d02-7e00-7000-8000-${String(n).padStart(12, "0")}`;

export const THREAD_ID = buildTaskId(900);

export const CARDS: readonly WorkCard[] = [
  buildCard(buildTaskId(1), {
    title: "Refund emails show the wrong currency",
    projectId: WEBSHOP.id,
    openQuestion: {
      sessionId: THREAD_ID,
      requestId: buildTaskId(901),
      text: "Which currency should win?",
    },
    openSessionId: THREAD_ID,
  }),
  buildCard(buildTaskId(2), {
    title: "Cache delivery slot lookups",
    projectId: WEBSHOP.id,
    stage: "in-review",
    failure: {
      runId: buildTaskId(902),
      workflowName: "Review PR",
      cause: "the branch changed mid-run",
    },
  }),
  buildCard(buildTaskId(3), {
    title: "Order history hides cancelled items",
    projectId: WEBSHOP.id,
    stage: "planned",
  }),
  buildCard(buildTaskId(4), {
    title: "Renew the payment gateway certificate",
    projectId: OPS.id,
    stage: "building",
    workingSessionId: buildTaskId(903),
  }),
  buildCard(buildTaskId(5), { title: "Tidy the depot labels" }),
];

export const BOARD_PATH = "GET /api/v1/tasks/board";

export const buildCreatedTask = (title: string, projectId: string | undefined): Task => ({
  id: buildTaskId(50),
  title,
  description: "",
  status: "open",
  stage: "exploring",
  priority: "normal",
  labels: [],
  ...(projectId === undefined ? {} : { projectId }),
  provenance: [],
  createdAt: "2026-11-02T09:00:00.000Z",
  updatedAt: "2026-11-02T09:00:00.000Z",
  statusChangedAt: "2026-11-02T09:00:00.000Z",
  stageChangedAt: "2026-11-02T09:00:00.000Z",
});

/**
 * Opens the app at Work. `board` is what the controller answers to each read,
 * and `handlers` replace the stub's answers. `hasAnyTask` is what the check
 * for a controller with no Task at all finds. `textGenerationUnavailableReason`
 * is why the controller says Text Generation cannot run, or null when it can.
 */
export const openWork = async ({
  board = () => buildBoard(...CARDS),
  hasAnyTask = true,
  textGenerationUnavailableReason = null,
  handlers = {},
  retryFailedReads = true,
  path = "/work",
  platform = "mac",
}: {
  readonly board?: () => WorkBoard;
  readonly hasAnyTask?: boolean;
  readonly textGenerationUnavailableReason?: string | null;
  readonly handlers?: Readonly<Record<string, Handler>>;
  readonly retryFailedReads?: boolean;
  readonly path?: string;
  readonly platform?: DesktopPlatform;
} = {}) => {
  const calls = stubApi({
    ...buildSidebarHandlers(SIDEBAR_FIXTURE),
    [BOARD_PATH]: () => ({ body: board() }),
    "GET /api/v1/controller": {
      body: {
        id: buildTaskId(7000),
        publicKey: "cHVibGljLWtleQ==",
        version: "0.4.2",
        defaultRunnerId: null,
        localRunnerId: null,
        textGeneration: {
          model: null,
          lastFailure: null,
          unavailableReason: textGenerationUnavailableReason,
        },
      },
    },
    "GET /api/v1/tasks": {
      body: { items: hasAnyTask ? [buildCreatedTask("Any", undefined)] : [] },
    },
    ...handlers,
  });
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer", platform }),
    {
      path,
      retryFailedReads,
    },
  );
  return { calls, ...app };
};

/** Returns the card named `title`: its button, which the screen reader names from its words. */
export const getCard = (title: string): HTMLElement =>
  screen.getByRole("button", { name: new RegExp(`^${title}`) });

export const detailPath = (taskId: string): string => `GET /api/v1/tasks/${taskId}/detail`;

/** Returns the details of `card` as `task.readDetail` answers them. `overrides` change any part. */
export const buildDetail = (card: WorkCard, overrides: Partial<TaskDetail> = {}): TaskDetail => ({
  task: {
    ...buildCreatedTask(card.title, card.projectId),
    id: card.id,
    stage: card.stage,
  },
  card,
  sessions: [],
  sessionCount: 0,
  runs: [],
  runCount: 0,
  blockers: [],
  blockerCount: 0,
  blocks: [],
  blockCount: 0,
  entities: [],
  places: [],
  edges: [],
  ...overrides,
});

/** Counts the calls to `route` (such as `POST /api/v1/...`) in `calls`. */
export const listCalls = (calls: readonly Call[], route: string): readonly Call[] =>
  calls.filter((call) => `${call.method} ${call.path}` === route);

/** How long the tests wait for an undo window they shortened, in milliseconds. */
export const SHORT_WINDOW_MS = 1_500;

/**
 * Makes the undo window of a held answer `SHORT_WINDOW_MS` long, by shortening
 * the one timer of that length. Fake timers cannot be used here: Testing
 * Library's `findBy` and `waitFor` wait on a timer of their own, which a fake
 * clock never fires.
 */
export const shortenUndoWindow = (): void => {
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => void,
    delay?: number,
    ...rest: unknown[]
  ) =>
    realSetTimeout(
      callback,
      delay === UNDO_WINDOW_MS ? SHORT_WINDOW_MS : delay,
      ...rest,
    )) as typeof setTimeout);
};

/** Waits longer than the shortened undo window, so a send that was going to happen has. */
export const waitOutUndoWindow = (): Promise<void> =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, SHORT_WINDOW_MS * 2)));

/** Returns `calls` to `route` with a body, such as `PATCH /api/v1/tasks/<id>`, as the bodies they sent. */
export const readBodies = (calls: readonly Call[], route: string): readonly unknown[] =>
  listCalls(calls, route).map((call) => call.body);

/** Focuses the card named `title`, as the arrow keys would, so single keys act on it. */
export const focusCard = (title: string): void => {
  act(() => {
    getCard(title).focus();
  });
};

/** The invented source of the repositories: its one-square mark is how a test tells it is drawn. */
const FORGE: PluginDetail = {
  id: "forge",
  displayName: "Forge",
  mark: { paths: ["M2 2h12v12H2z"] },
  hostApi: 2,
  capabilities: [],
  enabled: true,
  status: { _tag: "active" },
  config: {},
  contributions: [],
  intake: { eventKinds: [], signalKinds: [] },
  entityKinds: [],
};

export const REPOSITORY_KIND = "forge/repository";
export const REPOSITORY_CAPTION = "Forge repository";
export const DEPOT_REPOSITORY = buildPlace("forge:repo:depot", "depot-service", {
  kind: REPOSITORY_KIND,
  noun: "Repository",
  caption: REPOSITORY_CAPTION,
  status: { shape: "ring", tone: "active", label: "Active" },
  progress: { fraction: 3 / 7, done: 3, total: 7 },
});
export const STORE_REPOSITORY = buildPlace("forge:repo:store", "store-web", {
  kind: REPOSITORY_KIND,
  noun: "Repository",
  caption: REPOSITORY_CAPTION,
});

export const SHARED_ID = buildTaskId(30);
export const SHARED_TITLE = "Share the pallet scan library";

/** Four Tasks: one in the depot repository, one in the store repository, one in both, and one in none. */
export const REPOSITORY_CARDS: readonly WorkCard[] = [
  buildCard(SHARED_ID, {
    title: SHARED_TITLE,
    entityMarks: [{ plugin: "forge", kind: "forge/pull-request" }],
    contextRefs: [DEPOT_REPOSITORY.ref, STORE_REPOSITORY.ref],
  }),
  buildCard(buildTaskId(31), {
    title: "Print depot pick lists",
    entityMarks: [{ plugin: "forge", kind: "forge/issue" }],
    contextRefs: [DEPOT_REPOSITORY.ref],
  }),
  buildCard(buildTaskId(32), {
    title: "Show the basket total",
    projectId: WEBSHOP.id,
    entityMarks: [{ plugin: "forge", kind: "forge/issue" }],
    contextRefs: [STORE_REPOSITORY.ref],
  }),
  buildCard(buildTaskId(33), { title: "Tidy the depot labels", stage: "planned" }),
];

export const buildRepositoryBoard = (cards: readonly WorkCard[] = REPOSITORY_CARDS): WorkBoard => ({
  ...buildBoard(...cards),
  places: [DEPOT_REPOSITORY, STORE_REPOSITORY],
  groupings: [{ kind: REPOSITORY_KIND, caption: REPOSITORY_CAPTION }],
});

/** Opens Work on a board of repositories, with the repositories' plugin installed. */
export const openRepositoryWork = (
  options: {
    readonly board?: () => WorkBoard;
    readonly handlers?: Readonly<Record<string, Handler>>;
  } = {},
) =>
  openWork({
    board: options.board ?? (() => buildRepositoryBoard()),
    handlers: { "GET /api/v1/plugins": { body: [FORGE] }, ...options.handlers },
  });
