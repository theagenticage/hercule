/**
 * Controller answers for the Discussions and Wiki screens, for tests that only
 * need those screens to open: one Discussion, one wiki page, and a 404 for any
 * other id. The screens' own tests build richer records.
 */
import type { DiscussionSummary, WikiPageSummary } from "@hercule/contract";
import { buildErrorBody, SIDEBAR_FIXTURE, type Handler } from "./testing";

/** The id of the one Discussion the controller has. */
export const DISCUSSION_ID = "01a06d02-7f00-7000-8000-000000000001";

/** The id of the one wiki page the controller has. */
export const WIKI_PAGE_ID = "01a06d02-7e00-7000-8000-000000000001";

/** A well-formed id that no Discussion and no wiki page has. */
export const GONE_ID = "01a06d02-7f00-7000-8000-0000000000ff";

const DISCUSSION: DiscussionSummary = {
  id: DISCUSSION_ID,
  resourceId: SIDEBAR_FIXTURE.resources[0]!.id,
  repository: "github.com/acme/webshop",
  kind: "general",
  subject: "A subject",
  postCount: 0,
  sharedFileCount: 0,
  participantCount: 0,
  lastPostAt: "2026-10-01T09:00:00.000Z",
  createdAt: "2026-10-01T09:00:00.000Z",
};

const WIKI_PAGE: WikiPageSummary = {
  id: WIKI_PAGE_ID,
  resourceId: SIDEBAR_FIXTURE.resources[0]!.id,
  repository: "github.com/acme/webshop",
  slug: "page",
  title: "A page",
  summary: "What the page is about.",
  revision: 1,
  updatedAt: "2026-10-01T09:00:00.000Z",
  updatedBy: "user",
  createdAt: "2026-10-01T09:00:00.000Z",
};

const buildNotFound = (what: string): Handler => ({
  status: 404,
  body: buildErrorBody("not_found", `no ${what}`),
});

/**
 * Returns the handlers that let the Discussions and Wiki screens open: the
 * settings, both lists, and the reads of the one Discussion and the one page.
 * A read of `GONE_ID` answers not-found.
 */
export const buildDiscussionsWikiHandlers = (): Readonly<Record<string, Handler>> => ({
  "GET /api/v1/settings": { body: { controller: {}, user: { timezone: "UTC" } } },
  "GET /api/v1/discussions": { body: { items: [DISCUSSION] } },
  [`GET /api/v1/discussions/${DISCUSSION_ID}`]: {
    body: {
      discussion: { ...DISCUSSION, sharedFiles: [], participantSessionIds: [] },
      posts: [],
    },
  },
  [`GET /api/v1/discussions/${GONE_ID}`]: buildNotFound("discussion"),
  "GET /api/v1/wiki-pages": { body: { items: [WIKI_PAGE] } },
  [`GET /api/v1/wiki-pages/${WIKI_PAGE_ID}`]: {
    body: { page: { ...WIKI_PAGE, body: "The page." }, revisions: [] },
  },
  [`GET /api/v1/wiki-pages/${GONE_ID}`]: buildNotFound("wiki page"),
});
