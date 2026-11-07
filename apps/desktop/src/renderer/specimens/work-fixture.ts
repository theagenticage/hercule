/**
 * The records of the Work specimen (work.tsx): a board of the invented
 * Northwind Market world, as `task.queryBoard` would return it at the
 * specimen's clock, Tuesday 29 September 2026, 09:41 UTC.
 *
 * The board has four lanes, in the order the screen draws them (Projects by
 * name, then "No project"):
 *
 * - Depot ops: one card in each of four stages, so the lane is one row tall
 *   and the next lanes start high in the window. A colleague types behind the
 *   card in Building, and the card in In review failed, so its second line
 *   says which workflow failed and why.
 * - Field app: folded, so it draws as one line of dots.
 * - Storefront: five cards in Exploring, one with a very long title; five in
 *   Planned; two in Building; 18 in In review, one of them with a question
 *   (a raised palm), so the cell shows four cards, that card, and "13 more";
 *   and three in Landed, which draws as "3 landed".
 * - No project: two cards.
 *
 * Platform and Insights exist as Projects but hold no card, so the board
 * leaves their lanes out.
 */
import type { Project, TaskDetail, WorkBoard, WorkCard } from "@hercule/contract";
import { buildProject } from "@hercule/client-core/threads/testing";
import { buildBoard, buildCard, buildSummary } from "@hercule/client-core/work/testing";
import { SPECIMEN_NOW, SPECIMEN_RECORDS } from "./sidebar-fixture";
import type { SidebarRecords } from "./shell-page";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Returns the moment `hours` hours before the specimen's clock, as an ISO timestamp. */
const hoursAgo = (hours: number): string => new Date(SPECIMEN_NOW - hours * HOUR_MS).toISOString();

/** Returns the moment `days` days before the specimen's clock, as an ISO timestamp. */
const daysAgo = (days: number): string => new Date(SPECIMEN_NOW - days * DAY_MS).toISOString();

/** Returns the id of the Task numbered `n`. */
const taskId = (n: number): string => `01a0d1c0-6e80-7000-8000-${String(n).padStart(12, "0")}`;

/** Returns the id of the Thread numbered `n`. */
const sessionId = (n: number): string =>
  `01a0d1c0-6e80-7000-8000-${String(900 + n).padStart(12, "0")}`;

const STOREFRONT = buildProject("p-northwind-storefront", "Storefront");
const PLATFORM = buildProject("p-northwind-platform", "Platform");
const DEPOT_OPS = buildProject("p-northwind-depot-ops", "Depot ops");
const FIELD_APP = buildProject("p-northwind-field-app", "Field app");
const INSIGHTS = buildProject("p-northwind-insights", "Insights");

/** The Projects of the Northwind Market world. */
const NORTHWIND_PROJECTS: ReadonlyArray<Project> = [
  STOREFRONT,
  PLATFORM,
  DEPOT_OPS,
  FIELD_APP,
  INSIGHTS,
];

/** The title that does not fit on three lines of a card. */
const LONG_TITLE =
  "Search feed errors after the brand change, so that the shop finds again what customers were looking for last week";

/** The Thread of the colleague typing behind the card in Depot ops, Building. */
const TYPING_THREAD = sessionId(1);

/** The Thread whose question raises a palm behind the card in Storefront, In review. */
const ASKING_THREAD = sessionId(2);

/** The Thread of the run that failed on the card in Depot ops, In review. */
const FAILED_THREAD = sessionId(3);

/** One card of the board, by the facts the specimen sets: everything else is the card's usual. */
interface Placed {
  readonly project: Project | null;
  readonly stage: WorkCard["stage"];
  readonly title: string;
  /** Days since the card's last activity. Fractions are hours. */
  readonly idleDays: number;
  readonly extra?: Partial<WorkCard>;
}

const depot = (
  stage: WorkCard["stage"],
  title: string,
  idleDays: number,
  extra?: Partial<WorkCard>,
): Placed => ({
  project: DEPOT_OPS,
  stage,
  title,
  idleDays,
  ...(extra === undefined ? {} : { extra }),
});

const field = (stage: WorkCard["stage"], title: string, idleDays: number): Placed => ({
  project: FIELD_APP,
  stage,
  title,
  idleDays,
});

const shop = (
  stage: WorkCard["stage"],
  title: string,
  idleDays: number,
  extra?: Partial<WorkCard>,
): Placed => ({
  project: STOREFRONT,
  stage,
  title,
  idleDays,
  ...(extra === undefined ? {} : { extra }),
});

const unplaced = (stage: WorkCard["stage"], title: string, idleDays: number): Placed => ({
  project: null,
  stage,
  title,
  idleDays,
});

/** Every card, in the order of a cell: the board's stored order. */
const PLACED: ReadonlyArray<Placed> = [
  depot("exploring", "Show depot staff why an item came back", 3),
  depot("planned", "Scan a returned crate at the depot door", 4),
  depot("building", "Return labels at the depot", 0.1, {
    workingSessionId: TYPING_THREAD,
    openSessionId: TYPING_THREAD,
  }),
  depot("in-review", "Start the refund when the depot confirms", 0.2, {
    failure: {
      runId: taskId(800),
      workflowName: "Review PR",
      cause: "the branch changed mid-run",
    },
    openSessionId: FAILED_THREAD,
  }),

  field("exploring", "Proof of delivery while offline", 20),
  field("landed", "Drivers reorder their own stops", 8),

  shop("exploring", "Can coupons stack with loyalty points?", 28),
  shop("exploring", "Search latency on slow phones", 2),
  shop("exploring", "Rounding rules for multi-buy offers", 35),
  shop("exploring", "Typo tolerance for short search words", 4),
  shop("exploring", LONG_TITLE, 3),
  shop("planned", "Synonyms for everyday products", 12),
  shop("planned", "Substitutions when an item runs out", 20),
  shop("planned", "Guest checkout without an account", 14),
  shop("planned", "Basket drawer traps focus in one browser", 2),
  shop("planned", "Order history hides cancelled items", 4),
  shop("building", "Serve smaller product photos", 29),
  shop("building", "Renew the payment gateway certificate", 2),
  shop("in-review", "Delivery slot page feels slow at noon", 5),
  shop("in-review", "Golden tests for price rules", 1),
  shop("in-review", "Keyboard focus in the basket drawer", 0.5),
  shop("in-review", "Make the checkout load faster on phones", 2),
  shop("in-review", "Restore a basket after sign-in", 5, {
    openQuestion: {
      sessionId: ASKING_THREAD,
      requestId: "request-restore-basket",
      text: "Highest quantity, or add them?",
    },
    openSessionId: ASKING_THREAD,
  }),
  shop("in-review", "Move multi-buy rules into the price engine", 9),
  shop("in-review", "Price engine: handle weighed items", 3),
  shop("in-review", "Show the price breakdown in the basket", 1),
  shop("in-review", "Label the quantity buttons for screen readers", 3),
  shop("in-review", "Lazy-load photos below the fold", 12),
  shop("in-review", "Preload the checkout font", 1),
  shop("in-review", "Shorten the address form", 3),
  shop("in-review", "Gift card field on the payment step", 6),
  shop("in-review", "Fix the basket total on small phones", 4),
  shop("in-review", "Cache delivery slot lookups", 2),
  shop("in-review", "Round-trip test for price imports", 7),
  shop("in-review", "Dark mode for the order page", 10),
  shop("in-review", "Sticky basket button on narrow screens", 2),
  shop("landed", "Contrast audit for sale badges", 1),
  shop("landed", "Gift card balance on the receipt", 4),
  shop("landed", "Faster basket totals", 6),

  unplaced("exploring", "Tidy the depot labels", 6),
  unplaced("in-review", "Weekly flake report", 2),
];

/** Returns the card for the `index`-th entry of `PLACED`. Its Task id is `index` + 1, which stays clear of the Thread ids. */
const buildPlacedCard = (placed: Placed, index: number): WorkCard => {
  const lastActivityAt =
    placed.idleDays < 1 ? hoursAgo(placed.idleDays * 24) : daysAgo(placed.idleDays);
  return buildCard(taskId(index + 1), {
    title: placed.title,
    stage: placed.stage,
    boardRank: String(index + 1).padStart(4, "0"),
    ...(placed.project === null ? {} : { projectId: placed.project.id }),
    createdAt: daysAgo(placed.idleDays + 30),
    stageChangedAt: daysAgo(placed.idleDays + 1),
    lastActivityAt,
    ...placed.extra,
  });
};

/** What the Work specimen reads, besides the sidebar's lists. */
export interface WorkRecords {
  /** What `task.queryBoard` returns. */
  readonly board: WorkBoard;
  /** The ids of the lanes the user folded, which the screen keeps in `localStorage`. */
  readonly foldedLaneIds: readonly string[];
  /** What `task.readDetail` returns for the Tasks whose details the specimen opens. None when left out. */
  readonly details?: readonly TaskDetail[];
}

/** The board of the Work specimen. */
export const WORK_RECORDS: WorkRecords = {
  board: buildBoard(...PLACED.map(buildPlacedCard)),
  foldedLaneIds: [FIELD_APP.id],
};

/** The sidebar's lists with the Projects of the Northwind Market world added, for a specimen that opens Work. */
export const WORK_SIDEBAR_RECORDS: SidebarRecords = {
  ...SPECIMEN_RECORDS,
  projects: [...SPECIMEN_RECORDS.projects, ...NORTHWIND_PROJECTS],
};

/** The Task whose details the `work-details` specimen has open: the one that asks a question. */
const ASKING_CARD = WORK_RECORDS.board.cards.find(
  (card) => card.title === "Restore a basket after sign-in",
)!;

/** The Task with a failed run, on the board of the specimen. */
const FAILED_CARD = WORK_RECORDS.board.cards.find(
  (card) => card.title === "Start the refund when the depot confirms",
)!;

/**
 * The Work specimen with the details of the Task that asks open beside the
 * board: its summary and what is left, the question with two answers, and two
 * Threads, one of which asks.
 */
export const WORK_DETAILS_RECORDS: WorkRecords = {
  ...WORK_RECORDS,
  details: [
    {
      task: {
        id: ASKING_CARD.id,
        title: ASKING_CARD.title,
        description: "",
        status: "open",
        stage: ASKING_CARD.stage,
        priority: "normal",
        labels: [],
        projectId: STOREFRONT.id,
        provenance: [],
        createdAt: ASKING_CARD.createdAt,
        updatedAt: ASKING_CARD.lastActivityAt,
        statusChangedAt: ASKING_CARD.stageChangedAt,
        stageChangedAt: ASKING_CARD.stageChangedAt,
      },
      card: {
        ...ASKING_CARD,
        summary: buildSummary("One question is left on the PR.", {
          standing:
            "One question is left on the PR: which quantity wins when both baskets hold an item.",
          left: "Answer the quantity question",
          generatedAt: hoursAgo(1),
        }),
      },
      sessions: [
        {
          id: ASKING_THREAD,
          title: "Restore a basket after sign-in",
          role: null,
          kind: "thread",
          status: "idle",
          openRequests: [
            {
              requestId: "request-restore-basket",
              itemId: "item-restore-basket",
              kind: "question",
              detail: {
                questions: [
                  {
                    header: "Quantity",
                    question: "Highest quantity, or add them?",
                    options: [{ label: "Highest quantity" }, { label: "Add them together" }],
                    multiSelect: false,
                  },
                ],
              },
            },
          ],
          done: false,
        },
        {
          id: sessionId(4),
          title: "Merge the two baskets",
          role: null,
          kind: "thread",
          status: "idle",
          openRequests: [],
          done: true,
        },
      ],
      sessionCount: 2,
      runs: [],
      runCount: 0,
    },
    {
      task: {
        id: FAILED_CARD.id,
        title: FAILED_CARD.title,
        description: "",
        status: "open",
        stage: FAILED_CARD.stage,
        priority: "normal",
        labels: [],
        projectId: DEPOT_OPS.id,
        provenance: [],
        createdAt: FAILED_CARD.createdAt,
        updatedAt: FAILED_CARD.lastActivityAt,
        statusChangedAt: FAILED_CARD.stageChangedAt,
        stageChangedAt: FAILED_CARD.stageChangedAt,
      },
      card: {
        ...FAILED_CARD,
        summary: buildSummary("The review stopped early.", {
          standing: "The review stopped before it left any comments on the refund change.",
          left: "A review",
          generatedAt: hoursAgo(2),
        }),
      },
      sessions: [
        {
          id: FAILED_THREAD,
          title: "Start the refund when the depot confirms",
          role: null,
          kind: "thread",
          status: "idle",
          openRequests: [],
          done: false,
        },
      ],
      sessionCount: 1,
      runs: [],
      runCount: 0,
    },
  ],
};

/** The id of the Task whose details `WORK_DETAILS_RECORDS` opens first: the one that asks. */
export const WORK_OPEN_TASK_ID: string = ASKING_CARD.id;

/** The id of the Task with a failed run, whose details `WORK_DETAILS_RECORDS` also holds. */
export const WORK_FAILED_TASK_ID: string = FAILED_CARD.id;
