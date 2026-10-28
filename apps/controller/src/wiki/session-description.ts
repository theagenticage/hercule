/**
 * What a session is told about the Wiki when it starts: the Wiki's part of
 * the coordination paragraph, and what each repository's line says about its
 * Wiki (spec 19 section 7.1). The controller daemon puts these together with
 * the other parts; everything the Wiki says about itself is written here.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { prepareForQuoting, type Grant } from "@hercule/contract";
import { wikiPageRepository, type WikiOverview } from "./repository";

/** How many recently changed page titles a repository's line names. */
const MAX_LISTED_TITLES = 5;

/** How many characters of a page title a repository's line keeps. */
const MAX_QUOTED_TITLE_LENGTH = 60;

const READ_TEXT =
  "Each repository has a wiki that agents keep for the agents after them. " +
  "The repository's own docs (AGENTS.md, CLAUDE.md, ADRs) win over the wiki; the wiki holds what they do not say. " +
  "For larger work, checking the wiki is part of your research; a quick change does not need it. " +
  "List a repository's pages with `hercule wiki-page list --resource <id>`.";

const WRITE_TEXT =
  "When you learn something a future agent on this repository would need, write it down. " +
  "When a human allows an exception to a rule of the repository, record what was allowed, by whom and when.";

/** What the Wiki tells one session. */
export interface WikiDescription {
  /** The Wiki's part of the paragraph. */
  readonly text: string;
  /** What each repository's line says about its Wiki, by Resource id. */
  readonly repositoryNotes: ReadonlyMap<string, string>;
}

/**
 * Describes one repository's Wiki for its line: `Wiki: no pages yet.`, or the
 * number of pages and the quoted titles of the most recently changed ones.
 * The titles were written by other agents, so each is prepared with
 * `prepareForQuoting` before it is quoted.
 */
const describeOverview = ({ pageCount, recentTitles }: WikiOverview): string => {
  if (pageCount === 0) return "Wiki: no pages yet.";
  const titles = recentTitles
    .map((title) => `"${prepareForQuoting(title, MAX_QUOTED_TITLE_LENGTH)}"`)
    .join("; ");
  return `Wiki: ${String(pageCount)} ${pageCount === 1 ? "page" : "pages"}; recently changed, as written by agents: ${titles}.`;
};

/**
 * Builds what the Wiki tells a session holding `grants`, from the overviews of
 * the repositories that get a line of their own. Returns `undefined` for a
 * session without `wiki.read`, which is told nothing about the Wiki. A
 * session that may also write pages is asked to record what it learns.
 */
export const buildWikiDescription = (
  grants: ReadonlySet<Grant>,
  overviews: ReadonlyMap<string, WikiOverview>,
): WikiDescription | undefined => {
  if (!grants.has("wiki.read")) return undefined;
  return {
    text: grants.has("wiki.write") ? `${READ_TEXT} ${WRITE_TEXT}` : READ_TEXT,
    repositoryNotes: new Map(
      [...overviews].map(([resourceId, overview]) => [resourceId, describeOverview(overview)]),
    ),
  };
};

/**
 * Returns what the Wiki tells a session holding `grants` whose lines name the
 * repositories `resourceIds`, reading their Wikis as they are now. Returns
 * `undefined`, and reads nothing, for a session without `wiki.read`.
 */
export const describeWikiToSession = (
  grants: ReadonlySet<Grant>,
  resourceIds: ReadonlyArray<string>,
): Effect.Effect<WikiDescription | undefined, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    if (!grants.has("wiki.read")) return undefined;
    const pages = yield* wikiPageRepository;
    return buildWikiDescription(
      grants,
      yield* pages.summarizeWikis(resourceIds, MAX_LISTED_TITLES),
    );
  });
