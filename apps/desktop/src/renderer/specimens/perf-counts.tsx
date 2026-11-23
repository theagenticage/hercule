/**
 * The page the counts check drives (scripts/perf-counts.ts): the real app,
 * booted as `main.tsx` boots it, over a fake controller played inside the
 * page. Unlike the other specimens, nothing is seeded into the query cache:
 * the app's own loaders read, its own live connection subscribes, and its
 * own moves write and read again, so the check counts the requests the app
 * really sends.
 *
 * `?screen=inbox` opens the Inbox on 300 waiting things; `?screen=work` opens
 * Work on 300 Tasks in 10 Projects; `?screen=mcp` opens Settings > MCP servers
 * on three servers, with a thread that has them (perf-counts-mcp-world.ts).
 * The page exposes `window.perfCounts`
 * (`PerfCountsPage`) for the check to read the counters and to change the
 * world and push, as the controller would.
 *
 * The app boots through ./production-page, which leaves out `StrictMode` (it
 * renders every component twice in development and would double every render
 * count). The clock is stopped (./fixed-clock), so an age label never changes
 * during a step and no read goes stale on its own.
 */
// The probe comes first, so it is in place before React loads; the fixed clock
// next, because the app's age clock reads the time as soon as its module loads.
import { hasPendingWork, readProbe } from "./perf-probe";
import "./fixed-clock";
import type { Call, Handler } from "@hercule/client-core/testing";
import {
  answerFakeInboxQuery,
  buildFakeInboxDetail,
  buildInboxAsk,
  buildInboxOutline,
  buildInboxThing,
  type FakeInbox,
} from "@hercule/client-core/inbox/testing";
import { buildBoard, buildCard } from "@hercule/client-core/work/testing";
import {
  CORE_SAVED_QUERY_IDS,
  type InboxQuery,
  type InboxThing,
  type Signal,
  type Task,
  type WorkCard,
} from "@hercule/contract";
import { DEFAULT_APPEARANCE } from "../../ipc/appearance";
import { BOOT_HANDLERS, buildSidebarHandlers, SIDEBAR_FIXTURE } from "../app/fake-controller";
import { buildMcpWorld, MCP_THREAD } from "./perf-counts-mcp-world";
import type { PerfCountsPage } from "./perf-counts-page";
import { mountProductionApp } from "./production-page";
import { SPECIMEN_NOW } from "./sidebar-fixture";

declare global {
  interface Window {
    perfCounts?: PerfCountsPage;
  }
}

/** How many things the Inbox holds, and how many Tasks Work holds. */
const WORLD_SIZE = 300;

/** Returns the moment `hours` hours before the page's stopped clock, as an ISO string. */
const hoursBefore = (hours: number): string =>
  new Date(SPECIMEN_NOW - hours * 3_600_000).toISOString();

/** Returns the id of the `n`th record of the world, a version 7 UUID under `prefix`. */
const buildWorldId = (prefix: string, n: number): string =>
  `01a1d1cf-${prefix}-7000-8000-${String(n).padStart(12, "0")}`;

/**
 * Builds the Inbox's world: `WORLD_SIZE` review requests in "Someone waits on
 * me", each waiting a little longer than the next, and a changer that adds one
 * more thing that waited longest of all, so it arrives at the top of the list.
 */
function buildInboxWorld(): {
  handlers: Record<string, Handler>;
  changes: Record<string, () => void>;
} {
  const buildThing = (n: number): InboxThing =>
    buildInboxThing(String(n), {
      id: buildWorldId("aaaa", n),
      ref: `acme:ticket:${String(n)}`,
      arrival: n,
      title: `Review request ${String(n)}: the delivery slot lookup for depot ${String(n % 17)}`,
      asks: [buildInboxAsk(buildWorldId("aaab", n), n % 2 === 0 ? "Mei" : "Omar")],
      askCount: 1,
      askKinds: ["acme/review-requested"],
      openKinds: ["acme/review-requested"],
      waitingSince: hoursBefore(2 + n / 10),
    });
  const things = Array.from({ length: WORLD_SIZE }, (_, index) => buildThing(index + 1));
  // The arrival waited longest, so the list, ordered by the longest wait, ranks it first.
  const arrival = { ...buildThing(WORLD_SIZE + 1), waitingSince: hoursBefore(200) };
  const inbox: FakeInbox = {
    lists: { [CORE_SAVED_QUERY_IDS.waits]: [...things].reverse() },
    outline: buildInboxOutline({
      savedQueries: [
        {
          id: CORE_SAVED_QUERY_IDS.waits,
          name: "Someone waits on me",
          order: "waiting",
          signalKinds: [],
          count: WORLD_SIZE,
        },
      ],
    }),
    newestArrival: WORLD_SIZE,
    pageSize: 200,
    offerSets: {},
  };
  const everyThing = [...things, arrival];
  /** The id of the one open ask of the `n`th thing. */
  const buildAskId = (n: number): string => buildWorldId("aaab", n);
  // Each thing holds one open ask, so the pane reads it whole, as it does for a real thing.
  const details = Object.fromEntries(
    everyThing.map((thing, index) => {
      const n = index + 1;
      const detail = buildFakeInboxDetail(thing);
      const asker = n % 2 === 0 ? "Mei" : "Omar";
      return [
        `GET /api/v1/external-entities/${thing.id}`,
        {
          body: {
            ...detail,
            signals: [
              {
                id: buildAskId(n),
                kind: "acme/review-requested",
                title: thing.title,
                priority: "normal",
                status: "open",
                createdAt: hoursBefore(2),
                say: { say: `${asker} asked for your review`, tone: "plain" },
                snoozed: false,
                asks: true,
                asker,
              },
            ],
            openCount: 1,
            signalCount: 1,
          },
        },
      ];
    }),
  );
  const signals = Object.fromEntries(
    everyThing.map((thing, index) => {
      const id = buildAskId(index + 1);
      const signal: Signal = {
        id,
        kind: "acme/review-requested",
        origin: { type: "api", actor: "user", eventIds: [], reason: "Counts check" },
        title: thing.title,
        priority: "normal",
        blocks: [],
        actions: [
          {
            id: "approve",
            label: "Approve",
            primary: true,
            operation: { op: "acme/pr.approve", input: {} },
            describeLine: [{ kind: "text", text: "Approves the pull request" }],
          },
          { id: "done", label: "Done", operation: null },
        ],
        match: {},
        status: "open",
        createdAt: hoursBefore(2),
      };
      return [`GET /api/v1/signals/${id}`, { body: signal }];
    }),
  );
  // The pane reads the blocks of the open thing from its source: this world's things show none.
  const blocks = Object.fromEntries(
    [...things, arrival].map((thing) => [
      `GET /api/v1/external-entities/${thing.id}/blocks`,
      { body: { blocks: [] } },
    ]),
  );
  return {
    handlers: {
      "GET /api/v1/external-entities/inbox/count": () => ({
        body: {
          waiting: inbox.lists[CORE_SAVED_QUERY_IDS.waits]!.length,
          newestArrival: inbox.newestArrival,
        },
      }),
      "GET /api/v1/external-entities/inbox/outline": () => ({ body: inbox.outline }),
      "POST /api/v1/external-entities/inbox/query": (call: Call) => ({
        body: answerFakeInboxQuery(inbox, call.body as InboxQuery),
      }),
      "POST /api/v1/external-entities/dismiss": { body: {} },
      "POST /api/v1/external-entities/restore": { body: {} },
      ...details,
      ...signals,
      ...blocks,
    },
    changes: {
      arrive: () => {
        inbox.lists[CORE_SAVED_QUERY_IDS.waits] = [
          arrival,
          ...inbox.lists[CORE_SAVED_QUERY_IDS.waits]!,
        ];
        inbox.newestArrival = WORLD_SIZE + 1;
      },
    },
  };
}

/** The Projects of the Work world, from the sidebar fixture. */
const PROJECTS = SIDEBAR_FIXTURE.projects;

/** The stages a card of the Work world can be at, spread evenly. */
const STAGES = ["exploring", "planned", "building", "in-review", "landed"] as const;

/**
 * Builds the Work world: `WORLD_SIZE` Tasks spread over the fixture's
 * Projects and the five stages, every fourth with a working Thread. The move
 * handlers move a card as the controller would, and the changer renames the
 * first card, as a push about it would show.
 */
function buildWorkWorld(): {
  handlers: Record<string, Handler>;
  changes: Record<string, () => void>;
} {
  let cards: WorkCard[] = Array.from({ length: WORLD_SIZE }, (_, index) =>
    buildCard(buildWorldId("bbbb", index + 1), {
      title: `Task ${String(index + 1)}: tidy the depot ${String(index % 13)} labels`,
      projectId: PROJECTS[index % PROJECTS.length]!.id,
      stage: STAGES[Math.floor(index / PROJECTS.length) % STAGES.length]!,
      boardRank: String(index).padStart(6, "0"),
    }),
  );
  /** Returns the Task a move answers with, as the controller does. */
  const buildTask = (card: WorkCard): Task => ({
    id: card.id,
    title: card.title,
    description: "",
    status: "open",
    stage: card.stage,
    priority: card.priority,
    labels: [],
    ...(card.projectId === undefined ? {} : { projectId: card.projectId }),
    provenance: [],
    createdAt: card.createdAt,
    updatedAt: card.lastActivityAt,
    statusChangedAt: card.createdAt,
    stageChangedAt: card.stageChangedAt,
  });
  const moves = Object.fromEntries(
    cards.map((card) => [
      `POST /api/v1/tasks/${card.id}/move`,
      (call: Call) => {
        const { stage } = call.body as { stage?: WorkCard["stage"] };
        cards = cards.map((each) =>
          each.id === card.id ? { ...each, stage: stage ?? each.stage } : each,
        );
        return { body: buildTask(cards.find((each) => each.id === card.id)!) };
      },
    ]),
  );
  return {
    handlers: {
      "GET /api/v1/tasks/board": () => ({ body: buildBoard(...cards) }),
      "GET /api/v1/tasks": { body: { items: [buildTask(cards[0]!)] } },
      "GET /api/v1/controller": {
        body: {
          id: buildWorldId("cccc", 1),
          publicKey: "cHVibGljLWtleQ==",
          version: "0.4.2",
          defaultRunnerId: null,
          localRunnerId: null,
          textGeneration: { model: null, lastFailure: null, unavailableReason: null },
        },
      },
      ...moves,
    },
    changes: {
      rename: () => {
        cards = cards.map((card, index) =>
          index === 0 ? { ...card, title: `${card.title}, renamed` } : card,
        );
      },
    },
  };
}

const screenName = new URLSearchParams(location.search).get("screen");
const worlds = {
  inbox: buildInboxWorld,
  work: buildWorkWorld,
  mcp: () => ({ handlers: buildMcpWorld(), changes: {} as Record<string, () => void> }),
} as const;
/** The address each screen opens at. */
const START_PATHS = { inbox: "/inbox", work: "/work", mcp: "/settings/mcp-servers" } as const;
if (screenName !== "inbox" && screenName !== "work" && screenName !== "mcp") {
  throw new Error(
    `Unknown screen "${String(screenName)}" in the URL. Use ?screen=inbox, ?screen=work or ?screen=mcp.`,
  );
}
const world = worlds[screenName]();
const handlers: Record<string, Handler> = {
  ...BOOT_HANDLERS,
  // The thread of the MCP world is the sidebar's own, with its three servers.
  ...buildSidebarHandlers({
    ...SIDEBAR_FIXTURE,
    threads: SIDEBAR_FIXTURE.threads.map((thread) =>
      screenName === "mcp" && thread.id === MCP_THREAD.id ? MCP_THREAD : thread,
    ),
  }),
  ...world.handlers,
};
const { calls, sockets, context } = await mountProductionApp({
  handlers,
  path: START_PATHS[screenName],
  username: SIDEBAR_FIXTURE.username,
  appearance: DEFAULT_APPEARANCE,
});

window.perfCounts = {
  listRequests: () => calls.map((call) => `${call.method} ${call.path}`),
  listUnknownRequests: () =>
    calls.map((call) => `${call.method} ${call.path}`).filter((key) => handlers[key] === undefined),
  readProbe,
  isIdle: () => context.queryClient.isFetching() === 0 && context.queryClient.isMutating() === 0,
  isStill: () =>
    !hasPendingWork() &&
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.playState !== "running" ||
          animation.effect?.getComputedTiming().endTime === Infinity,
      ),
  isLive: () =>
    sockets.at(-1)?.readyState === 1 &&
    sockets
      .at(-1)!
      .subscriptions()
      .some((each) => each.topic === "session"),
  push: (topic, ids) => {
    const socket = sockets.at(-1);
    if (socket === undefined) throw new Error("The app has not opened its live connection.");
    socket.push(topic, { _tag: "invalidate", ids, kind: "updated" });
  },
  changeWorld: (change) => {
    const apply = world.changes[change];
    if (apply === undefined) throw new Error(`The ${screenName} world has no change "${change}".`);
    apply();
  },
};
