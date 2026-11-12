/**
 * PROTOTYPE, throwaway. The Hercule side of the world: Tasks, the agent
 * sessions working on them, and the workflows a user can start, built on top
 * of the outside world of world.ts.
 *
 * Starting work is modelled on what workflows already declare. A workflow is
 * offered wherever its input can be filled, so no screen has to know about a
 * workflow in advance:
 *
 * - `thing`: one External Entity of the listed kinds (spec 07 already has
 *   this as an entity input). Offered on a card.
 * - `things`: several External Entities at once, as one run over the set.
 *   Offered on a selection.
 * - `each`: one run per selected thing. Offered on a selection.
 * - `task`: a Hercule Task. Offered on a Task card.
 * - `project`: a Linear project, with every issue in it. Offered on a project.
 * - `view`: the query of a screen (a split, a dashboard block): the run gets
 *   the query and reads the matching things itself. Offered on a block.
 * - `none`: no input. Offered in the command palette, and as a button a
 *   screen pins.
 *
 * A screen may also pin a workflow: it stores the workflow's id and which of
 * its own values fills the input. That is a placement, not a trigger.
 */
import type { KindId, Thing, World } from "./world";

export type Stage =
  | "exploring"
  | "planned"
  | "building"
  | "in-review"
  | "landed"
  | "done"
  | "dropped";
export const STAGES: readonly Stage[] = ["exploring", "planned", "building", "in-review", "landed"];

export type SessionState = "working" | "waiting" | "idle" | "failed";

export interface AgentSession {
  readonly id: string;
  readonly name: string;
  readonly state: SessionState;
  /** What the session asks the user, when it waits. */
  readonly question?: string | undefined;
  /** Minutes since the state began. */
  readonly sinceMin: number;
}

export interface Task {
  readonly id: string;
  readonly title: string;
  readonly stage: Stage;
  /** The Hercule project, the lane a card sits in on Work. */
  readonly lane: string;
  readonly initiative?: string | undefined;
  readonly sessions: readonly AgentSession[];
  /** Ids of the outside things the Task links. */
  readonly links: readonly string[];
  /** Minutes since the Task last changed. */
  readonly sinceMin: number;
  /** Minutes until its target date, when it has one. */
  readonly dueMin?: number | undefined;
  /** A Task waits on another Task, by title. */
  readonly blockedBy?: string | undefined;
  /** The six-word line of its Task Summary. */
  readonly summary: string;
  readonly startedBy?: string | undefined;
}

export type InputShape =
  | { readonly type: "thing"; readonly kinds: readonly KindId[] }
  | { readonly type: "things"; readonly kinds: readonly KindId[] }
  | { readonly type: "each"; readonly kinds: readonly KindId[] }
  | { readonly type: "task" }
  | { readonly type: "project" }
  | { readonly type: "view" }
  | { readonly type: "none" };

export interface Workflow {
  readonly id: string;
  readonly name: string;
  readonly does: string;
  readonly input: InputShape;
  /** The agent that runs it. */
  readonly agent: string;
}

const ALL_THINGS: readonly KindId[] = [
  "linear/issue",
  "github/issue",
  "github/pull-request",
  "sentry/issue",
  "gmail/thread",
  "intercom/conversation",
  "slack/thread",
  "discord/thread",
  "pagerduty/incident",
  "calendar/invite",
];

export const WORKFLOWS: readonly Workflow[] = [
  {
    id: "wf-review",
    name: "Review a pull request",
    does: "Reads the diff, runs it, and posts a review in your voice",
    input: { type: "thing", kinds: ["github/pull-request"] },
    agent: "Reviewer",
  },
  {
    id: "wf-deliver",
    name: "Deliver as a pull request",
    does: "Plans, builds and opens a pull request for the ticket",
    input: { type: "thing", kinds: ["linear/issue", "github/issue"] },
    agent: "Builder",
  },
  {
    id: "wf-fix",
    name: "Lowest-cost fix proposal",
    does: "Finds the cause of an error and proposes the smallest fix",
    input: { type: "thing", kinds: ["sentry/issue", "pagerduty/incident"] },
    agent: "Fixer",
  },
  {
    id: "wf-reply",
    name: "Draft a reply",
    does: "Drafts an answer with what Hercule knows, for you to send",
    input: {
      type: "thing",
      kinds: ["gmail/thread", "intercom/conversation", "slack/thread", "discord/thread"],
    },
    agent: "Writer",
  },
  {
    id: "wf-checks",
    name: "Fix failing checks",
    does: "One run per pull request: rebase, fix the checks, push",
    input: { type: "each", kinds: ["github/pull-request"] },
    agent: "Builder",
  },
  {
    id: "wf-triage",
    name: "Triage these together",
    does: "One run over the set: groups them, links what belongs together, proposes Tasks",
    input: { type: "things", kinds: ALL_THINGS },
    agent: "Triager",
  },
  {
    id: "wf-continue",
    name: "Continue this Task",
    does: "Picks the Task up where its last session stopped",
    input: { type: "task" },
    agent: "Builder",
  },
  {
    id: "wf-plan",
    name: "Plan the project",
    does: "Reads every issue in the project and proposes an order and owners",
    input: { type: "project" },
    agent: "Planner",
  },
  {
    id: "wf-digest",
    name: "Summarise this block",
    does: "Reads everything the block's query finds and writes a short digest",
    input: { type: "view" },
    agent: "Writer",
  },
  {
    id: "wf-briefing",
    name: "Morning briefing",
    does: "What changed overnight, across every source",
    input: { type: "none" },
    agent: "Writer",
  },
];

/** Checks whether a workflow can be started on a selection of things, and says how many runs it would make. */
export function offerForThings(
  workflow: Workflow,
  things: readonly Thing[],
): { readonly ok: boolean; readonly runs: number; readonly why?: string } {
  const { input } = workflow;
  if (things.length === 0) return { ok: false, runs: 0, why: "Nothing selected" };
  if (input.type === "thing") {
    // A workflow that takes one thing runs once per thing on a selection, so no workflow needs a separate "each" input for that.
    if (things.length > 1) {
      const fits = things.filter((t) => input.kinds.includes(t.kind.id));
      if (fits.length === 0)
        return {
          ok: false,
          runs: 0,
          why: `Takes a ${input.kinds.map((k) => k.split("/")[1]!.replace("-", " ")).join(" or ")}`,
        };
      return {
        ok: true,
        runs: fits.length,
        why:
          fits.length < things.length
            ? `one run each, for ${String(fits.length)} of ${String(things.length)}`
            : "one run each",
      };
    }
    return input.kinds.includes(things[0]!.kind.id)
      ? { ok: true, runs: 1 }
      : {
          ok: false,
          runs: 0,
          why: `Takes a ${input.kinds.map((k) => k.split("/")[1]!.replace("-", " ")).join(" or ")}`,
        };
  }
  if (input.type === "things" || input.type === "each") {
    const fits = things.filter((t) => input.kinds.includes(t.kind.id));
    if (fits.length === 0)
      return {
        ok: false,
        runs: 0,
        why: `Takes ${input.kinds.length > 3 ? "outside things" : input.kinds.map((k) => k.split("/")[1]!.replace("-", " ")).join(" or ")}`,
      };
    if (fits.length < things.length)
      return {
        ok: true,
        runs: input.type === "each" ? fits.length : 1,
        why: `${String(fits.length)} of ${String(things.length)} fit`,
      };
    return { ok: true, runs: input.type === "each" ? fits.length : 1 };
  }
  return { ok: false, runs: 0, why: "Not started from things" };
}

const AGENTS = ["Ada", "Grace", "Linus", "Margaret", "Alan", "Edsger", "Barbara", "Ken"];

/** Builds the user's Tasks: some made from outside things they took on, some started in Hercule itself. */
export function buildTasks(world: World): Task[] {
  const find = (identifier: string): Thing | undefined =>
    world.things.find((t) => t.identifier === identifier);
  const linked = (...ids: (string | undefined)[]): string[] =>
    ids.flatMap((id) =>
      id === undefined ? [] : [find(id)?.id].filter((x): x is string => x !== undefined),
    );
  const session = (
    name: string,
    state: SessionState,
    sinceMin: number,
    question?: string,
  ): AgentSession => ({ id: `s-${name}-${String(sinceMin)}`, name, state, sinceMin, question });
  const tasks: Task[] = [
    {
      id: "task-1",
      title: "Fix 3-D Secure checkout for EU cards",
      stage: "building",
      lane: "monorepo",
      initiative: "Checkout reliability",
      sessions: [session("Ada", "waiting", 12, "Run git push?")],
      links: [],
      sinceMin: 12,
      summary: "Fix ready, waiting to push",
    },
    {
      id: "task-2",
      title: "Settle a gift card that covers the whole order",
      stage: "in-review",
      lane: "monorepo",
      initiative: "Checkout reliability",
      sessions: [session("Grace", "idle", 35)],
      links: linked("BE-861", "#73301", "CHECKOUT-API-4K2"),
      sinceMin: 35,
      summary: "PR open, two checks failing",
    },
    {
      id: "task-3",
      title: "Migrate ops dashboards",
      stage: "building",
      lane: "infra",
      sessions: [session("Linus", "waiting", 48, "Keep the old Grafana folder?")],
      links: [],
      sinceMin: 48,
      summary: "Six of nine dashboards moved",
    },
    {
      id: "task-4",
      title: "Move the the carrier webhook to a signed route",
      stage: "in-review",
      lane: "monorepo",
      initiative: "Checkout reliability",
      sessions: [],
      links: linked("DATA-82", "#73176", "#318"),
      sinceMin: 24 * 60,
      summary: "Approved, waiting on the secret",
      blockedBy: "Add the the carrier signing secret",
    },
    {
      id: "task-5",
      title: "Remove the obsolete service clients",
      stage: "building",
      lane: "monorepo",
      initiative: "Backend cleanup",
      sessions: [session("Margaret", "working", 6), session("Alan", "working", 19)],
      links: linked("BE-820", "#73155", "#73160"),
      sinceMin: 6,
      summary: "Three of seven clients removed",
    },
    {
      id: "task-6",
      title: "Find dead endpoints and the code only they reach",
      stage: "in-review",
      lane: "monorepo",
      initiative: "Backend cleanup",
      sessions: [],
      links: linked("BE-810", "#73230"),
      sinceMin: 26 * 60,
      summary: "Finder done, review pending",
    },
    {
      id: "task-7",
      title: "Cut web install time in CI under two minutes",
      stage: "building",
      lane: "monorepo",
      sessions: [session("Edsger", "failed", 95)],
      links: linked("PLA-212", "#73290"),
      sinceMin: 95,
      summary: "Bun install works, e2e fails",
    },
    {
      id: "task-8",
      title: "Payout reconciliation counts a payout on the wrong day",
      stage: "exploring",
      lane: "monorepo",
      sessions: [session("Barbara", "working", 3)],
      links: linked("FIN-77", "FINANCE-WORKER-1B"),
      sinceMin: 3,
      dueMin: 2 * 24 * 60,
      summary: "Reading the September close",
    },
    {
      id: "task-9",
      title: "Upgrade the workers to Effect 4",
      stage: "planned",
      lane: "monorepo",
      initiative: "Flash sales on Effect 4",
      sessions: [],
      links: linked("PLA-220", "#73244"),
      sinceMin: 4 * 24 * 60,
      dueMin: 9 * 24 * 60,
      summary: "Plan agreed, not started",
    },
    {
      id: "task-10",
      title: "Season calendar on seller pages",
      stage: "planned",
      lane: "storefront",
      initiative: "Seller partnerships Q1",
      sessions: [],
      links: linked("SRCH-2043"),
      sinceMin: 6 * 24 * 60,
      dueMin: 20 * 24 * 60,
      summary: "Waiting on the seller feed",
      blockedBy: "Seller feed import",
    },
    {
      id: "task-11",
      title: "Clear the type warnings, service by service",
      stage: "landed",
      lane: "monorepo",
      initiative: "Backend cleanup",
      sessions: [],
      links: linked("BE-754"),
      sinceMin: 7 * 60,
      summary: "Merged, 412 warnings left",
    },
    {
      id: "task-12",
      title: "Hercule: inbox for many sources",
      stage: "exploring",
      lane: "hercule",
      sessions: [session("Ken", "working", 1)],
      links: [],
      sinceMin: 1,
      summary: "Round four of the prototype",
    },
  ];
  // A few more from the tail, so the lanes have weight at scale.
  const tail = world.things
    .filter((t) => t.kind.id === "linear/issue" && t.turn === "you" && t.stage === "In Progress")
    .slice(0, 10);
  tail.forEach((t, i) => {
    const working = i % 3 === 0;
    tasks.push({
      id: `task-tail-${String(i)}`,
      title: t.title,
      stage: i % 4 === 0 ? "in-review" : "building",
      lane: i % 5 === 0 ? "storefront" : "monorepo",
      sessions: working
        ? [
            {
              id: `s-tail-${String(i)}`,
              name: AGENTS[i % AGENTS.length]!,
              state: "working",
              sinceMin: 10 + i * 7,
            },
          ]
        : [],
      links: [t.id],
      sinceMin: 60 + i * 140,
      summary: working ? "Building, tests written" : "Paused, nobody on it",
    });
  });
  return tasks;
}

/** Returns the Task that links a thing, if one does. */
export function findTaskOf(thing: Thing, tasks: readonly Task[]): Task | undefined {
  return tasks.find((task) => task.links.includes(thing.id));
}
