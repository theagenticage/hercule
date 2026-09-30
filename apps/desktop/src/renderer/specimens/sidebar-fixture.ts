/**
 * The records the sidebar specimen seeds its query cache with, as the
 * controller would return them: the threads of the Bureau book's
 * session-active.html sidebar, their projects, their runner, the provider
 * instances whose catalogs name their models, and the signed-in user.
 *
 * The app's test fixtures (`SIDEBAR_FIXTURE` in app/testing.tsx) cannot be
 * used here: that module imports vitest and Testing Library, which do not
 * run in a page, and its threads are not the book's.
 *
 * The reference sheet reads this module too (sidebar-reference.ts), to edit
 * the book's sidebar where the app draws the fixture's data instead of the
 * book's: the model names and the counts line. The sidebar states fixture
 * (sidebar-states-fixture.ts) builds its threads on the same runner, from the
 * same model catalogs.
 */
import type {
  ModelOption,
  OpenRequest,
  Project,
  ProviderInstance,
  Runner,
  Session,
} from "@hercule/contract";
import { buildProject, buildRunner, buildSession } from "@hercule/client-core/threads/testing";
import type { SidebarRecords } from "./shell-page";

/**
 * The moment the specimen's clock stands still at: 2026-09-29 09:41 UTC, ten
 * minutes after the Fix thread's Request opened, as the book's "Waiting on
 * you since 09:31 · 10m" has it. Every other time is counted back from it.
 */
export const SPECIMEN_NOW = Date.UTC(2026, 8, 29, 9, 41, 0);

/**
 * The ids of the two threads waiting on the user. Each id hashes, through
 * `buildLook`, to the look the book's CAST table in crew.js gives the thread's
 * full title, so both sheets draw the same face:
 *
 * - Fix: peach, egg, tache;
 * - Migrate: mint, wide, bowtie.
 *
 * `node scripts/find-look-seeds.ts` found them: it counts through
 * UUIDv7-shaped ids and prints the first one with each look.
 */
export const FIX_THREAD_ID = "01a0ec64-6e80-7000-8000-000000000024";
export const MIGRATE_THREAD_ID = "01a0ec64-6e80-7000-8000-000000000019";

/**
 * A model a thread runs: the provider instance, the model's slug, the name
 * its catalog gives it, and the options its catalog offers.
 */
export interface SpecimenModel {
  readonly instanceId: string;
  readonly slug: string;
  readonly name: string;
  readonly options: ReadonlyArray<ModelOption>;
}

export const CLAUDE_SONNET: SpecimenModel = {
  instanceId: "i-claude",
  slug: "claude-sonnet-5",
  name: "Claude Sonnet 5",
  options: [],
};

/** The model of the thread the thread specimen opens, with the effort option Claude Code reports. */
export const CLAUDE_OPUS: SpecimenModel = {
  instanceId: "i-claude",
  slug: "claude-opus-5-5",
  name: "Opus 5.5",
  options: [
    {
      id: "effort",
      label: "Effort",
      kind: "select",
      choices: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
      ],
      default: "medium",
    },
  ],
};

export const GPT: SpecimenModel = {
  instanceId: "i-codex",
  slug: "gpt-5.4",
  name: "GPT-5.4",
  options: [],
};

/** One thread of the book's sidebar, and what the fixture gives it. */
interface SpecimenThread {
  readonly id: string;
  readonly title: string;
  readonly projectId: string;
  readonly status: Session["status"];
  /** How long before `SPECIMEN_NOW` the thread was last active. */
  readonly minutesAgo: number;
  readonly model: SpecimenModel;
  readonly openRequest: OpenRequest | null;
}

/** The book's three projects, in the book's order. A project's tint follows its place in this list. */
const PROJECTS: ReadonlyArray<Project> = [
  buildProject("p-webshop", "webshop"),
  buildProject("p-payments-api", "payments-api"),
  buildProject("p-ops", "ops"),
];

/** The machine the threads run on, online. */
export const STUDIO_MAC: Runner = buildRunner("r-studio-mac", "studio-mac");

/**
 * The book's seven threads. Their activity times give the book's order:
 *
 * - Waiting on you: Fix, then Migrate;
 * - the projects: webshop (newest thread Fix), payments-api (Payout), ops
 *   (Migrate);
 * - inside each project: Fix, Read, Refactor; Payout, iDEAL; Migrate, Rotate.
 *
 * Read and iDEAL are idle, so their rows show their age: "20m" and "1h".
 * Every thread is on one runner, which is online, and in no workspace, so no
 * workspace label is drawn.
 */
export const SPECIMEN_THREADS: ReadonlyArray<SpecimenThread> = [
  {
    id: FIX_THREAD_ID,
    title: "Fix 3-D Secure checkout for EU cards",
    projectId: "p-webshop",
    status: "busy",
    minutesAgo: 2,
    model: CLAUDE_SONNET,
    openRequest: {
      requestId: "rq-fix",
      itemId: "it-fix",
      kind: "command_approval",
      decisions: ["allow", "deny"],
      detail: { command: "git push" },
    },
  },
  {
    id: "s-payout",
    title: "Payout report for September",
    projectId: "p-payments-api",
    status: "busy",
    minutesAgo: 5,
    model: GPT,
    openRequest: null,
  },
  {
    id: MIGRATE_THREAD_ID,
    title: "Migrate ops dashboards",
    projectId: "p-ops",
    status: "busy",
    minutesAgo: 8,
    model: CLAUDE_SONNET,
    openRequest: {
      requestId: "rq-migrate",
      itemId: "it-migrate",
      kind: "question",
      decisions: ["allow", "cancel"],
      detail: {
        questions: [
          {
            question: "Keep the old Grafana folder?",
            header: "Grafana",
            options: [
              { label: "Keep", description: "Leave the v10 dashboards where they are." },
              { label: "Delete", description: "Remove the v10 dashboards." },
            ],
            multiSelect: false,
          },
        ],
      },
    },
  },
  {
    id: "s-rotate",
    title: "Rotate staging secrets",
    projectId: "p-ops",
    status: "busy",
    minutesAgo: 12,
    model: CLAUDE_SONNET,
    openRequest: null,
  },
  {
    id: "s-read",
    title: "Read the Stripe v14 changelog",
    projectId: "p-webshop",
    status: "idle",
    minutesAgo: 20,
    model: CLAUDE_SONNET,
    openRequest: null,
  },
  {
    id: "s-refactor",
    title: "Refactor cart totals",
    projectId: "p-webshop",
    status: "busy",
    minutesAgo: 35,
    model: CLAUDE_SONNET,
    openRequest: null,
  },
  {
    id: "s-ideal",
    title: "Add iDEAL research",
    projectId: "p-payments-api",
    status: "idle",
    minutesAgo: 75,
    model: GPT,
    openRequest: null,
  },
];

/**
 * The counts line the sidebar's foot draws for the fixture: Payout, Rotate
 * and Refactor are working, Fix and Migrate wait on the user, Read and iDEAL
 * are idle.
 */
export const SPECIMEN_COUNTS = { working: 3, waiting: 2, idle: 2 } as const;

/** Returns a provider instance whose one capability snapshot lists `models`. */
const buildInstance = (
  id: string,
  providerId: string,
  displayName: string,
  models: ReadonlyArray<SpecimenModel>,
): ProviderInstance => ({
  id,
  providerId,
  name: displayName,
  config: {},
  displayName,
  binaryName: providerId,
  declared: {
    steering: "native",
    fork: "native",
    modelSwitch: "in-session",
    accessModes: {
      "approval-required": "native",
      "auto-accept-edits": "native",
      auto: "native",
      "full-access": "native",
    },
    mcpPassthrough: "native",
    disallowedTools: "native",
    structuredOutput: "supported",
  },
  secretFields: [],
  snapshots: [
    {
      runnerId: STUDIO_MAC.id,
      probedAt: new Date(SPECIMEN_NOW).toISOString(),
      harnessVersion: null,
      versionVerdict: "unknown",
      auth: { status: "ok" },
      models: models.map(({ slug, name, options }) => ({ slug, name, options })),
    },
  ],
  createdAt: new Date(SPECIMEN_NOW).toISOString(),
  updatedAt: new Date(SPECIMEN_NOW).toISOString(),
});

/** The two provider instances, whose catalogs give the threads' models their names. */
export const SPECIMEN_INSTANCES: ReadonlyArray<ProviderInstance> = [
  buildInstance(CLAUDE_SONNET.instanceId, "claude-code", "Claude Code", [
    CLAUDE_SONNET,
    CLAUDE_OPUS,
  ]),
  buildInstance(GPT.instanceId, "codex", "Codex", [GPT]),
];

/**
 * Returns a thread's session: on studio-mac unless `over` names another
 * runner, running `model`, and last active `minutesAgo` minutes before
 * `SPECIMEN_NOW`. Every other field is `buildSession`'s default unless `over`
 * sets it.
 */
export const buildSpecimenSession = ({
  minutesAgo,
  model,
  ...over
}: Partial<Session> & {
  readonly id: string;
  readonly title: string;
  readonly minutesAgo: number;
  readonly model: SpecimenModel;
}): Session =>
  buildSession({
    runnerId: STUDIO_MAC.id,
    instanceId: model.instanceId,
    modelSelection: { model: model.slug, options: {} },
    lastActivityAt: new Date(SPECIMEN_NOW - minutesAgo * 60_000).toISOString(),
    ...over,
  });

/** Every list the sidebar reads, as its query returns it. */
export const SPECIMEN_RECORDS: SidebarRecords = {
  threads: SPECIMEN_THREADS.map(
    ({ id, title, projectId, status, minutesAgo, model, openRequest }) =>
      buildSpecimenSession({ id, title, projectId, status, minutesAgo, model, openRequest }),
  ),
  projects: PROJECTS,
  workspaces: [],
  resources: [],
  runners: [STUDIO_MAC],
  instances: SPECIMEN_INSTANCES,
  user: { username: "Rogier" },
};
