/**
 * The records of the thread header specimen (thread-header.tsx): the
 * ten Threads of one workspace that the Workbench, refined drawing shows in
 * `?state=stress` (docs/design/sidebar-directions/shared/world.js, `STRESS`),
 * with its lead open. The drawing's header at `?header=a` draws one tab per
 * Thread.
 *
 * The ten Threads keep the drawing's titles, roles, poses, ages and order:
 * each started and was last active the minutes before `SPECIMEN_NOW` that
 * the drawing's clock times (`started`, `last`) count back from its own
 * 09:41. They share one worktree on studio-mac, which is what makes them one
 * row. The models are the drawing's, in catalogs that name them as the
 * drawing does.
 *
 * The drawing calls its lead's tab "lead" and gives no role to its lead. In
 * the app the first Thread has no special case: a tab shows its role, or its
 * title when it has none. So the fixture gives the lead the role "lead", the
 * word the drawing draws, to compare the layout of a tab and not a generated
 * word. The two partners the user added without a role keep none, and their
 * tabs show their titles, as the drawing's do.
 */
import type { Session } from "@hercule/contract";
import { buildCheckout, buildRepo, buildWorkspace } from "@hercule/client-core/threads/testing";
import {
  buildInstance,
  buildSpecimenSession,
  CLAUDE_OPUS,
  CLAUDE_SONNET,
  GPT,
  SPECIMEN_NOW,
  SPECIMEN_RECORDS,
  STUDIO_MAC,
  type SpecimenModel,
} from "./sidebar-fixture";
import type { SidebarRecords, ThreadScreenRecords } from "./shell-page";

/** The drawing's Sonnet 5, which the sidebar fixture's catalog calls "Claude Sonnet 5". */
const SONNET: SpecimenModel = { ...CLAUDE_SONNET, name: "Sonnet 5" };

/** The drawing's gpt-5.4, which the sidebar fixture's catalog calls "GPT-5.4". */
const GPT_54: SpecimenModel = { ...GPT, name: "gpt-5.4" };

/** The drawing's Haiku 4.5, which the other fixtures do not use. */
const HAIKU: SpecimenModel = {
  instanceId: "i-claude",
  slug: "claude-haiku-4-5",
  name: "Haiku 4.5",
  imageInput: { maxBytes: null },
  options: [],
};

/** The drawing's gpt-5.4-mini. */
const GPT_MINI: SpecimenModel = {
  instanceId: "i-codex",
  slug: "gpt-5.4-mini",
  name: "gpt-5.4-mini",
  imageInput: { maxBytes: null },
  options: [],
};

/** The session the specimen opens: the lead of the ten, whose tab the drawing marks as open. */
export const OPEN_SESSION_ID = "s-result-lead";

const PAYMENTS_REPO = buildRepo(
  "res-payments-api",
  "git@github.com:acme/payments-api.git",
  "github.com/acme/payments-api",
  ["p-payments-api"],
);

/** The worktree the ten Threads share: `rogier/result-error-shape` of payments-api, on studio-mac. */
const RESULT_WORKSPACE = buildWorkspace({
  id: "ws-result",
  runnerId: STUDIO_MAC.id,
  kind: "ephemeral",
  checkouts: [
    { ...buildCheckout(PAYMENTS_REPO.id, "rogier/result-error-shape"), form: "worktree" },
  ],
  sessionIds: [],
});

/** What the specimen holds of one Thread: its id, role, title, the minutes since it started and was last active, its model, and whether it is busy. */
type Partner = readonly [
  id: string,
  role: string | null,
  title: string,
  startedAgo: number,
  lastAgo: number,
  model: SpecimenModel,
  busy: boolean,
];

/** The ten Threads of the drawing's `STRESS`, in the drawing's order. */
const PARTNERS: ReadonlyArray<Partner> = [
  [
    OPEN_SESSION_ID,
    "lead",
    "Migrate the unmigrated payout endpoints to the Result error shape",
    89,
    0,
    CLAUDE_OPUS,
    true,
  ],
  [
    "s-result-review",
    "review",
    "Adversarial review of the Result error shape on the payout endpoints",
    61,
    4,
    GPT_54,
    true,
  ],
  [
    "s-result-tests",
    "tests",
    "Write contract tests for every migrated payout endpoint",
    57,
    1,
    GPT_MINI,
    true,
  ],
  [
    "s-result-docs",
    "API docs",
    "Update the OpenAPI document for the new Result error responses",
    21,
    0,
    SONNET,
    true,
  ],
  [
    "s-result-inventory",
    "inventory",
    "Find every payout endpoint that still returns a raw IActionResult",
    86,
    70,
    HAIKU,
    false,
  ],
  [
    "s-result-mobile",
    "mobile check",
    "Check that the mobile app still parses payout errors after the change",
    39,
    17,
    GPT_54,
    false,
  ],
  [
    "s-result-bench",
    "benchmark",
    "Benchmark payout list latency before and after the migration",
    43,
    30,
    GPT_MINI,
    false,
  ],
  [
    "s-result-refunds",
    "refunds review",
    "Second adversarial pass on refunds and reversals under the new error shape",
    36,
    8,
    CLAUDE_OPUS,
    false,
  ],
  [
    "s-result-changelog",
    null,
    "Draft the changelog entry and the migration note for API consumers",
    15,
    11,
    HAIKU,
    false,
  ],
  [
    "s-result-stripe",
    null,
    "Ask whether Stripe can send payout.failed twice for the same payout",
    27,
    22,
    SONNET,
    false,
  ],
];

/** The Thread of the ten that asks a question: the drawing's `review`, which waits on the user. */
const ASKER_ID = "s-result-review";

/** The ten Threads, with the review's open question. */
const THREADS: ReadonlyArray<Session> = PARTNERS.map(
  ([id, role, title, startedAgo, lastAgo, model, busy]) =>
    buildSpecimenSession({
      id,
      title,
      role,
      projectId: "p-payments-api",
      workspaceId: RESULT_WORKSPACE.id,
      status: busy ? "busy" : "idle",
      minutesAgo: lastAgo,
      createdAt: new Date(SPECIMEN_NOW - startedAgo * 60_000).toISOString(),
      model,
      openRequests:
        id === ASKER_ID
          ? [
              {
                requestId: "rq-result-review",
                itemId: "it-result-review",
                kind: "question",
                detail: {
                  questions: [
                    {
                      question: "Should a 409 from Stripe become a Result error or a retry?",
                      header: "Question",
                      options: [
                        { label: "Result error", description: "Return it as an error." },
                        { label: "Retry", description: "Try the call again." },
                      ],
                      multiSelect: false,
                    },
                  ],
                },
              },
            ]
          : [],
    }),
);

/** Every list the shell reads: the ten Threads, their worktree and repository, and the book's three projects. */
export const THREAD_HEADER_RECORDS: SidebarRecords = {
  ...SPECIMEN_RECORDS,
  threads: THREADS,
  workspaces: [RESULT_WORKSPACE],
  resources: [PAYMENTS_REPO],
  instances: [
    buildInstance("i-claude", "claude-code", "Claude Code", [SONNET, CLAUDE_OPUS, HAIKU]),
    buildInstance("i-codex", "codex", "Codex", [GPT_54, GPT_MINI]),
  ],
};

/** What the thread screen reads of the lead: no transcript, because the pair compares the header alone. */
export const THREAD_HEADER_THREAD: ThreadScreenRecords = {
  session: THREADS.find(({ id }) => id === OPEN_SESSION_ID)!,
  transcript: [],
  queuedInputs: [],
};
