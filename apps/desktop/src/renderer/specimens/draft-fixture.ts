/**
 * The records the draft specimen seeds its query cache with, as the
 * controller would return them: the Draft Thread in webshop of the Bureau
 * book's session-empty.html, with the picks its composer shows and the three
 * open tasks its start cards offer.
 *
 * The user has picked a new workspace of webshop, which starts from main,
 * edits accepted, and Opus 5.5 at high effort. webshop's repo has a main
 * workspace on studio-mac, on main, so the app knows the branch a new
 * workspace starts from, as the book's lip names it.
 *
 * The start cards are two Proposals and one Task, most urgent first, as the
 * book draws them. The app draws a card's source as the GitHub mark or, for
 * any other source, the tasks glyph, and always draws the priority's bars:
 *
 * - the book's Sentry Proposal came from a GitHub issue here, and is urgent,
 *   the book's four bars;
 * - the book's Stripe Proposal came from a Stripe event, and is normal, the
 *   book's two bars;
 * - the book's Task has no source and no bars, and is low here, one bar.
 *
 * The book's page has two more states, for a fresh install whose Intake is
 * still empty, and the specimen is opened with the same `?state=`:
 *
 * - `first`: the same draft, with no open task and a GitHub Connection, so
 *   the starters are about code and the line under them says that Triage
 *   reads GitHub;
 * - `first-no-repo`: webshop has no repo and nothing is connected, so the
 *   draft works without a checkout, the starters are about knowledge work,
 *   and the line under them asks the user to connect GitHub.
 *
 * Everything else is the sidebar specimen's (sidebar-fixture.ts).
 *
 * The reference sheet reads this module too (draft-reference.ts), to edit the
 * book's draft where the app draws the fixture's data instead of the book's.
 */
import type { ThreadPicks } from "@hercule/client-core";
import {
  GITHUB_CONNECTION_TYPE,
  type Connection,
  type Resource,
  type Task,
  type TaskPriority,
  type Workspace,
} from "@hercule/contract";
import { buildCheckout, buildRepo, buildWorkspace } from "@hercule/client-core/threads/testing";
import type { DraftScreenRecords, SidebarRecords } from "./shell-page";
import { CLAUDE_OPUS, SPECIMEN_NOW, SPECIMEN_RECORDS, STUDIO_MAC } from "./sidebar-fixture";

/** webshop's one repo. */
const WEBSHOP_REPO: Resource = buildRepo(
  "r-webshop",
  "git@github.com:acme/webshop.git",
  "github.com/acme/webshop",
  ["p-webshop"],
);

/** webshop's main workspace on studio-mac, on main, the branch a new workspace starts from. */
const WEBSHOP_MAIN_WORKSPACE: Workspace = buildWorkspace({
  id: "w-webshop-main",
  runnerId: STUDIO_MAC.id,
  checkouts: [buildCheckout(WEBSHOP_REPO.id, "main")],
});

/** A start card's task: its title, its priority, its labels, and the external ref it came from, if any. */
interface SpecimenTask {
  readonly id: string;
  readonly title: string;
  readonly priority: TaskPriority;
  readonly labels: ReadonlyArray<string>;
  readonly ref: string | null;
}

/** The three open tasks of webshop, most urgent first, as the start cards' query returns them. */
const START_TASKS: ReadonlyArray<SpecimenTask> = [
  {
    id: "t-3ds-checkout",
    title: "Fix: Checkout fails for EU cards with 3‑D Secure",
    priority: "urgent",
    labels: ["proposed"],
    ref: "github:issue:acme/webshop#1289",
  },
  {
    id: "t-webhook-retries",
    title: "Investigate: Stripe webhook retries rising",
    priority: "normal",
    labels: ["proposed"],
    ref: "stripe:event:evt_1Q2w3E4r5T6y",
  },
  {
    id: "t-cart-rounding",
    title: "Cart total rounding on discounts",
    priority: "low",
    labels: [],
    ref: null,
  },
];

/** Returns `task` as the controller stores it: open, in webshop, created an hour before `SPECIMEN_NOW`. */
const buildOpenTask = ({ id, title, priority, labels, ref }: SpecimenTask): Task => {
  const at = new Date(SPECIMEN_NOW - 60 * 60_000).toISOString();
  return {
    id,
    title,
    description: "",
    status: "open",
    priority,
    labels,
    projectId: "p-webshop",
    provenance: ref === null ? [] : [{ ref, at, actor: "system" }],
    createdAt: at,
    updatedAt: at,
    statusChangedAt: at,
  };
};

/** What the user picked in the draft's composer. */
const DRAFT_PICKS: ThreadPicks = {
  workspace: { kind: "ephemeral", checkouts: [{ resourceId: WEBSHOP_REPO.id }] },
  accessMode: "auto-accept-edits",
  model: CLAUDE_OPUS.slug,
  options: { effort: "high" },
};

/** The Draft Thread in webshop, as the draft screen reads it. */
export const WEBSHOP_DRAFT: DraftScreenRecords = {
  projectId: "p-webshop",
  startTasks: START_TASKS.map(buildOpenTask),
  connections: [],
  picks: DRAFT_PICKS,
};

/** The user's GitHub Connection, made an hour before `SPECIMEN_NOW`. */
const GITHUB_CONNECTION: Connection = {
  id: "c-github",
  type: GITHUB_CONNECTION_TYPE,
  label: "rogier",
  displayName: "rogier",
  status: "connected",
  labels: [],
  config: {},
  feedIntervals: {},
  credentials: [],
  createdAt: new Date(SPECIMEN_NOW - 60 * 60_000).toISOString(),
  updatedAt: new Date(SPECIMEN_NOW - 60 * 60_000).toISOString(),
};

/** The Draft Thread in webshop on a fresh install: no open task, and GitHub connected. */
const FIRST_DRAFT: DraftScreenRecords = {
  ...WEBSHOP_DRAFT,
  startTasks: [],
  connections: [GITHUB_CONNECTION],
};

/**
 * The Draft Thread in webshop on a fresh install where GitHub was put off:
 * webshop has no repo and nothing is connected, so there is no workspace to
 * pick.
 */
const FIRST_NO_REPO_DRAFT: DraftScreenRecords = {
  projectId: "p-webshop",
  startTasks: [],
  connections: [],
  picks: { accessMode: "auto-accept-edits", model: CLAUDE_OPUS.slug, options: { effort: "high" } },
};

/** Every list the shell reads: the sidebar specimen's, with webshop's repo and its main workspace. */
export const DRAFT_PAGE_RECORDS: SidebarRecords = {
  ...SPECIMEN_RECORDS,
  resources: [WEBSHOP_REPO],
  workspaces: [WEBSHOP_MAIN_WORKSPACE],
};

/** The records and the draft the specimen draws for one state of the book's page. */
export interface DraftFixture {
  readonly records: SidebarRecords;
  readonly draft: DraftScreenRecords;
}

/**
 * Returns the fixture for the book's `?state=`: `first`, `first-no-repo`,
 * or, for no state or any other, the draft with its start cards. When
 * webshop has no repo, the shell's lists are the sidebar specimen's, which
 * hold no repo and no workspace.
 */
export const chooseDraftFixture = (state: string | null): DraftFixture => {
  switch (state) {
    case "first":
      return { records: DRAFT_PAGE_RECORDS, draft: FIRST_DRAFT };
    case "first-no-repo":
      return { records: SPECIMEN_RECORDS, draft: FIRST_NO_REPO_DRAFT };
    default:
      return { records: DRAFT_PAGE_RECORDS, draft: WEBSHOP_DRAFT };
  }
};
