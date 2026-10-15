import { useId, type JSX } from "react";
import { useSuspenseQuery, type QueryClient } from "@tanstack/react-query";
import { Link, createFileRoute, notFound, type NotFoundRouteProps } from "@tanstack/react-router";
import {
  formatRepositoryPath,
  type HerculeClient,
  isNotFound,
  readActorSessionId,
  resolveDisplayTimezone,
} from "@hercule/client-core";
import { buildWikiHistory } from "@hercule/client-core/wiki-history";
import { throwScreenNotFound } from "../../../../app/last-screen";
import { readSenders, settingsQuery, wikiPageQuery } from "../../../../app/queries";
import { readFullSearch } from "../../../../screens/list-pane/list-with-open-pane";
import { NotFound } from "../../../../screens/not-found";
import { Markdown } from "../../../../screens/session/markdown";
import { OldRevisionBand, WikiHistoryList, WikiPageLead } from "../../../../screens/wiki/wiki-page";

/**
 * The search params of an open wiki page (spec 19 section 8.2):
 *
 * - `full`: the open page fills the pane, and the list is hidden;
 * - `revision`: the page as of that older revision; without it, the current
 *   page.
 */
interface WikiPageSearch {
  readonly full?: true | undefined;
  readonly revision?: number | undefined;
}

/**
 * Returns an open page's search params from the URL's. A param with any other
 * value is dropped, so the page shows its default: a `full` that is not
 * `true`, and a `revision` that is not a positive whole number.
 *
 * A dropped param is returned as `undefined` rather than left out, because
 * the router lays the returned params over the URL's: a param left out would
 * keep the URL's value.
 */
const validateWikiPageSearch = (search: Record<string, unknown>): WikiPageSearch => ({
  full: readFullSearch(search),
  revision:
    typeof search.revision === "number" &&
    Number.isSafeInteger(search.revision) &&
    search.revision > 0
      ? search.revision
      : undefined,
});

/**
 * An open wiki page (spec 19 section 8.2). A row of the wiki list links here,
 * and its row is selected while the page is open.
 *
 * Its loader reads the page, as of `revision` when the URL names one, with
 * its newest revisions, then the sessions of the agents that wrote those
 * revisions, so their names are drawn at the first paint. When no page has
 * the id, the route shows `WikiPageNotFound`. When the page exists but has no
 * such revision, it shows `WikiPageNotFound` too, which then names the
 * missing revision and links to the current page.
 * The settings are read by the Wiki layout and are cached already.
 *
 * Opening another page, or another revision, runs the loader again, and it
 * reads only what is not cached.
 */
export const Route = createFileRoute("/_connected/_shell/wiki/$pageId")({
  staticData: { title: "Wiki" },
  validateSearch: validateWikiPageSearch,
  loaderDeps: ({ search }) => ({ revision: search.revision }),
  loader: async ({
    context: { controller, queryClient },
    params: { pageId },
    deps: { revision },
    location,
  }) => {
    const { client } = controller;
    try {
      const { revisions } = await queryClient.ensureQueryData(
        wikiPageQuery(client, pageId, revision),
      );
      const senderSessionIds = new Set(
        revisions.flatMap((entry) => readActorSessionId(entry.actor) ?? []),
      );
      await readSenders(queryClient, client, [...senderSessionIds]);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      if (revision !== undefined && (await hasCurrentPage(client, queryClient, pageId))) {
        const data: MissingRevision = { revision };
        // The router acts on a thrown `notFound`, a plain descriptor rather than an Error.
        // oxlint-disable-next-line typescript/only-throw-error
        throw notFound({ data });
      }
      throwScreenNotFound(location);
    }
  },
  component: OpenWikiPageRoute,
  notFoundComponent: WikiPageNotFound,
});

/** What the loader passes `WikiPageNotFound` when the page exists but has no such revision. */
interface MissingRevision {
  readonly revision: number;
}

/**
 * Checks whether the page `pageId` exists, by reading its current revision.
 * Fails with any error but not-found.
 */
const hasCurrentPage = async (
  client: HerculeClient,
  queryClient: QueryClient,
  pageId: string,
): Promise<boolean> => {
  try {
    await queryClient.ensureQueryData(wikiPageQuery(client, pageId, undefined));
    return true;
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return false;
  }
};

/**
 * Renders the screen of a page that does not exist, with a link back to the
 * list, or, when the loader passes a `MissingRevision`, the screen of a
 * revision the page does not have, with a link to the current page.
 */
function WikiPageNotFound({ data }: NotFoundRouteProps): JSX.Element {
  const { pageId } = Route.useParams();
  const missing = data as MissingRevision | undefined;
  if (missing !== undefined) {
    return (
      <NotFound headline={`This wiki page has no revision ${String(missing.revision)}.`}>
        <Link to="/wiki/$pageId" params={{ pageId }} className="btn btn--accent">
          Current revision
        </Link>
      </NotFound>
    );
  }
  return (
    <NotFound headline="This wiki page was not found.">
      <Link to="/wiki" className="btn btn--accent">
        Wiki
      </Link>
    </NotFound>
  );
}

/**
 * Draws the open page afresh for each page and each revision, so its pane
 * starts at the top instead of keeping the scroll position of the page or
 * revision opened before. A push for the page, or widening it to fill the
 * pane, keeps the pane and its position.
 */
function OpenWikiPageRoute(): JSX.Element {
  const { pageId } = Route.useParams();
  const { revision } = Route.useSearch();
  return (
    <OpenWikiPage key={`${pageId}:${revision ?? "current"}`} pageId={pageId} revision={revision} />
  );
}

/**
 * Reads the page `pageId`, as of `revision` or the current page when there is
 * none, and draws it: the band when it is an older revision, the lead, the
 * body, and the History beside it. The page is a section named by its title.
 */
function OpenWikiPage({
  pageId,
  revision,
}: {
  readonly pageId: string;
  readonly revision: number | undefined;
}): JSX.Element {
  const { controller } = Route.useRouteContext();
  const { client } = controller;
  const { full } = Route.useSearch();
  const headingId = useId();
  const { data } = useSuspenseQuery(wikiPageQuery(client, pageId, revision));
  const { data: settings } = useSuspenseQuery(settingsQuery(client));
  const timezone = resolveDisplayTimezone(settings.user.timezone);

  const { page } = data;
  const history = buildWikiHistory(data.revisions);
  const isFull = full === true;

  return (
    <section className="open-pane" aria-labelledby={headingId}>
      <div className="pill-room" />
      {page.revision === history.currentRevision ? null : (
        <OldRevisionBand
          pageId={pageId}
          revision={page.revision}
          currentRevision={history.currentRevision}
          updatedAt={page.updatedAt}
          timezone={timezone}
          isFull={isFull}
        />
      )}
      <WikiPageLead
        headingId={headingId}
        title={page.title}
        summary={page.summary}
        repository={formatRepositoryPath(page.repository)}
      />
      <div className="page-body">
        <div className="msg-body">
          <Markdown text={page.body} />
        </div>
        <WikiHistoryList pageId={pageId} history={history} timezone={timezone} isFull={isFull} />
      </div>
    </section>
  );
}
