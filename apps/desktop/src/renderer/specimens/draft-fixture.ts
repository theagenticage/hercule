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
 * Everything else is the sidebar specimen's (sidebar-fixture.ts).
 *
 * The reference sheet reads this module too (draft-reference.ts), to edit the
 * book's draft where the app draws the fixture's data instead of the book's.
 */
import type { ThreadPicks } from "@hercule/client-core";
import type { Resource, Task, TaskPriority, Workspace } from "@hercule/contract";
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
  picks: DRAFT_PICKS,
};

/** Every list the shell reads: the sidebar specimen's, with webshop's repo and its main workspace. */
export const DRAFT_PAGE_RECORDS: SidebarRecords = {
  ...SPECIMEN_RECORDS,
  resources: [WEBSHOP_REPO],
  workspaces: [WEBSHOP_MAIN_WORKSPACE],
};
