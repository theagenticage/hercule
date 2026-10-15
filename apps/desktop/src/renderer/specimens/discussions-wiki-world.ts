/**
 * The records the Discussions and Wiki specimens share: the four agents whose
 * sessions wrote Posts and Wiki revisions, the projects and repositories the
 * Bureau book's two pages group their lists by, and the shell records around
 * them. The clock the times are read against is list-week-clock.ts.
 *
 * Each agent's session id hashes, through `buildLook`, to the look the book's
 * crew.js hashes from the agent's title, so both sheets draw the same face.
 * The ids were found by counting through UUIDv7-shaped ids, as
 * scripts/find-look-seeds.ts does:
 *
 * - Refactor checkout totals: mint, tall, tache and bowtie;
 * - Fix cart rounding: sky, tall, monocle;
 * - Add gift card support: sky, wide, homburg;
 * - Fix payout retries: iris, round, tache.
 */
import type { Project, Session } from "@hercule/contract";
import { buildProject, buildRepo } from "@hercule/client-core/threads/testing";
import type { SidebarRecords } from "./shell-page";
import { buildSpecimenSession, CLAUDE_SONNET, SPECIMEN_RECORDS } from "./sidebar-fixture";

/** Returns the moment at `time`, "HH:MM", on `date`, "YYYY-MM-DD", UTC, as an ISO instant. */
export const buildInstant = (date: string, time: string): string => `${date}T${time}:00.000Z`;

/** Returns the actor stamp of a change the session of `agent` made: `session:<id>`. */
export const buildSessionStamp = (agent: { readonly id: string }): string => `session:${agent.id}`;

/** Returns the id of record `number` of the kind `prefix` names, such as the repositories' `7c00`. */
export const buildId = (prefix: string, number: number): string =>
  `01a06d02-${prefix}-7000-8000-${String(number).padStart(12, "0")}`;

/** An agent of the book's two pages: the title its thread has, and the session id that gives it its face. */
interface SpecimenAgent {
  readonly id: string;
  readonly title: string;
}

export const REFACTOR_AGENT: SpecimenAgent = {
  id: "01a0ec64-6e80-7000-8000-000000000131",
  title: "Refactor checkout totals",
};
export const ROUNDING_AGENT: SpecimenAgent = {
  id: "01a0ec64-6e80-7000-8000-0000000003a9",
  title: "Fix cart rounding",
};
export const GIFT_CARD_AGENT: SpecimenAgent = {
  id: "01a0ec64-6e80-7000-8000-000000000265",
  title: "Add gift card support",
};
export const PAYOUT_AGENT: SpecimenAgent = {
  id: "01a0ec64-6e80-7000-8000-000000000055",
  title: "Fix payout retries",
};

/** The sessions of the four agents, which the screens read to name each one and draw its face. */
export const AGENT_SESSIONS: ReadonlyArray<Session> = [
  REFACTOR_AGENT,
  ROUNDING_AGENT,
  GIFT_CARD_AGENT,
  PAYOUT_AGENT,
].map(({ id, title }) => buildSpecimenSession({ id, title, minutesAgo: 30, model: CLAUDE_SONNET }));

/** A repository of the book's two pages: its id, and the canonical remote its Discussions and pages carry. */
interface SpecimenRepository {
  readonly resourceId: string;
  readonly repository: string;
}

export const STOREFRONT: SpecimenRepository = {
  resourceId: buildId("7c00", 1),
  repository: "github.com/acme/storefront",
};
export const CHECKOUT_API: SpecimenRepository = {
  resourceId: buildId("7c00", 2),
  repository: "github.com/acme/checkout-api",
};
export const PAYMENTS: SpecimenRepository = {
  resourceId: buildId("7c00", 3),
  repository: "github.com/acme/payments",
};
export const LEGACY_ADMIN: SpecimenRepository = {
  resourceId: buildId("7c00", 4),
  repository: "github.com/acme/legacy-admin",
};

/**
 * The shell's records for the two pages: the sidebar's, with the book's
 * project names, and the repositories. webshop holds two repositories, so its
 * list draws a sub-heading for each, payments holds one, and legacy-admin is
 * in no project.
 */
export const DISCUSSIONS_WIKI_RECORDS: SidebarRecords = {
  ...SPECIMEN_RECORDS,
  // The sidebar's second project is "payments-api"; the book's two pages name it "payments".
  projects: SPECIMEN_RECORDS.projects.map((project): Project =>
    project.id === "p-payments-api" ? buildProject(project.id, "payments") : project,
  ),
  resources: [
    buildRepo(STOREFRONT.resourceId, "git@github.com:acme/storefront.git", STOREFRONT.repository, [
      "p-webshop",
    ]),
    buildRepo(
      CHECKOUT_API.resourceId,
      "git@github.com:acme/checkout-api.git",
      CHECKOUT_API.repository,
      ["p-webshop"],
    ),
    buildRepo(PAYMENTS.resourceId, "git@github.com:acme/payments.git", PAYMENTS.repository, [
      "p-payments-api",
    ]),
    buildRepo(
      LEGACY_ADMIN.resourceId,
      "git@github.com:acme/legacy-admin.git",
      LEGACY_ADMIN.repository,
    ),
  ],
};
