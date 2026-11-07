/**
 * What the Add to Work sheet says under its search: the line about where it
 * searches, which list shows (suggestions, bars, results or one sentence),
 * the rows of each, and the line that reports an add. The components only
 * draw what these return.
 */
import type {
  EntityPlace,
  EntitySearchReply,
  EntitySearchResult,
  EntitySuggestion,
  EntitySuggestions,
  TaskStage,
} from "@hercule/contract";
import { readEntityPluginId } from "../desk/entity-words";
import { buildRelationProgress, type RelationProgress } from "../desk/relation-rows";
import { readPlaceName } from "./context-lanes";
import { STAGE_NAMES } from "./card-words";
import type { ScopeOption } from "./add-sources";

/** The line under the search: where the search reaches, or why it reaches nowhere. */
export type SearchLine =
  /** Why the source cannot be searched. It is drawn in full ink, because it matters more than the rest. */
  | { readonly kind: "offline"; readonly text: string }
  /** That a pasted link is being read. */
  | { readonly kind: "link"; readonly text: string }
  /** "Searches <select> in GitHub": the select shows `allLabel` when no context is chosen. */
  | {
      readonly kind: "scope";
      readonly lead: string;
      readonly allLabel: string;
      /** "in GitHub" after a chosen context, and none after "all of GitHub". */
      readonly trailing: string | null;
    };

/**
 * Describes the line under the search.
 *
 * - Offline, the line says the source cannot be searched. Typing then only
 *   narrows the suggestions, which need no source.
 * - While a pasted link is read, it says so, and names the source once the
 *   answer has told which one the link is from (`linkSourceName`).
 * - Otherwise it says exactly what is searched: "Searches all of GitHub", or
 *   "Searches acme/storefront-web in GitHub" with the context chosen in a select.
 */
export const describeSearchLine = ({
  sourceName,
  scope,
  isOffline,
  isLink,
  linkSourceName,
}: {
  readonly sourceName: string;
  readonly scope: ScopeOption | undefined;
  readonly isOffline: boolean;
  readonly isLink: boolean;
  readonly linkSourceName?: string | undefined;
}): SearchLine => {
  if (isOffline) {
    return {
      kind: "offline",
      text: `You are offline, so ${sourceName} cannot be searched. Typing only narrows the suggestions.`,
    };
  }
  if (isLink) {
    return {
      kind: "link",
      text:
        linkSourceName === undefined
          ? "Reading this link."
          : `Reading this link from ${linkSourceName}.`,
    };
  }
  return {
    kind: "scope",
    lead: "Searches",
    allLabel: `all of ${sourceName}`,
    trailing: scope === undefined ? null : `in ${sourceName}`,
  };
};

/** Returns what the search field says it is for: "Search GitHub, or paste a link". */
export const describeSearchPlaceholder = (sourceName: string): string =>
  `Search ${sourceName}, or paste a link`;

/** One thing the sheet lists, as a suggestion or as a result. */
export interface AddRow {
  readonly ref: string;
  /** How the source names it, such as "WEB-301". */
  readonly identifier: string;
  readonly title: string;
  /** The small line under the title, such as "Gift cards · New to Hercule", or `undefined`. */
  readonly note: string | undefined;
  /** The state the source reports, such as "Todo". Empty for a kind with no status. */
  readonly state: string;
  /** The Task that already has this thing, so a click opens it instead of adding it. */
  readonly taskId: string | undefined;
}

/** What a heading over suggestions says about the context they sit under. */
export interface SuggestionHeading {
  readonly title: string;
  /** For example "Linear project · In progress". */
  readonly facts: string;
  /** Only when the source reports it. */
  readonly progress: RelationProgress | undefined;
}

/** The suggestions under one heading, or under none when they sit under no known context. */
export interface SuggestionGroup {
  readonly ref: string;
  readonly heading: SuggestionHeading | undefined;
  readonly rows: readonly AddRow[];
}

const describeHeading = (place: EntityPlace): SuggestionHeading => ({
  title: readPlaceName(place),
  facts: [place.caption ?? place.noun, place.status?.label]
    .filter((part) => part !== undefined)
    .join(" · "),
  progress: place.progress === undefined ? undefined : buildRelationProgress(place.progress),
});

/** Returns whether the row's identifier or title holds `text`, ignoring case. */
const rowMatches = (suggestion: EntitySuggestion, text: string): boolean => {
  const wanted = text.trim().toLowerCase();
  return (
    wanted === "" || `${suggestion.identifier} ${suggestion.title}`.toLowerCase().includes(wanted)
  );
};

/**
 * Returns the suggestions of `sourceId`, each under the context it sits in.
 *
 * - Only things of that source are listed, because the controller lists the
 *   suggestions of every source.
 * - With a context chosen (`scopeRef`), every thing sits under it, and
 *   `alsoIn` names its other contexts. With none, a thing sits under the
 *   first of its contexts, and the rest are the others.
 * - A thing in two contexts is listed once, and its note says "Also in
 *   Pricing rules".
 * - `narrowedBy` keeps only the things whose identifier or title holds those
 *   words, for the sheet that is offline.
 * - A heading takes the first place of the group that `places` or the reply
 *   knows. Groups keep the order of the first thing in each.
 *
 * `places` are the stored places the sheet already holds (the Work board's).
 */
export const buildSuggestionGroups = ({
  reply,
  places,
  sourceId,
  scopeRef,
  narrowedBy,
}: {
  readonly reply: EntitySuggestions;
  readonly places: ReadonlyArray<EntityPlace>;
  readonly sourceId: string;
  readonly scopeRef: string | undefined;
  readonly narrowedBy: string;
}): readonly SuggestionGroup[] => {
  const known = new Map([...places, ...reply.places].map((place) => [place.ref, place]));
  const groups = new Map<string, { headingRef: string; rows: AddRow[] }>();
  for (const suggestion of reply.suggestions) {
    if (readEntityPluginId(suggestion.kind) !== sourceId || !rowMatches(suggestion, narrowedBy)) {
      continue;
    }
    const headingRef = scopeRef ?? suggestion.alsoIn[0] ?? "";
    const others = (
      scopeRef === undefined ? suggestion.alsoIn.slice(1) : suggestion.alsoIn
    ).flatMap((ref) => {
      const place = known.get(ref);
      return place === undefined ? [] : [readPlaceName(place)];
    });
    const group = groups.get(headingRef) ?? { headingRef, rows: [] };
    group.rows.push({
      ref: suggestion.ref,
      identifier: suggestion.identifier,
      title: suggestion.title,
      note: others.length === 0 ? undefined : `Also in ${others.join(", ")}`,
      state: suggestion.status?.label ?? "",
      taskId: undefined,
    });
    groups.set(headingRef, group);
  }
  return [...groups.values()].map((group) => {
    const place = known.get(group.headingRef);
    return {
      ref: group.headingRef,
      heading: place === undefined ? undefined : describeHeading(place),
      rows: group.rows,
    };
  });
};

/**
 * Returns the rows of a search's results. A result with no title or identifier
 * (a link to something the user cannot open) is not a row, because there is
 * nothing to show or add.
 */
export const buildResultRows = (results: ReadonlyArray<EntitySearchResult>): readonly AddRow[] =>
  results.flatMap((result) =>
    result.title === undefined || result.identifier === undefined
      ? []
      : [
          {
            ref: result.ref,
            identifier: result.identifier,
            title: result.title,
            note:
              [result.location, result.standing === "new" ? "New to Hercule" : undefined]
                .filter((part) => part !== undefined)
                .join(" · ") || undefined,
            state: result.status?.label ?? "",
            taskId: result.standing === "on-work" ? result.taskId : undefined,
          },
        ],
  );

/** Where a search stands, as the sheet's read of it says. */
export type SearchState =
  /** Nothing is being searched: no words, or typing has not stopped yet. */
  | { readonly status: "idle" }
  | { readonly status: "pending" }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "answered"; readonly reply: EntitySearchReply };

/** What fills the sheet's list. */
export type AddListView =
  /** The suggestions, headed by `title` and `text`. The rows come from `buildSuggestionGroups`. */
  | { readonly kind: "suggestions"; readonly title: string; readonly text: string }
  /** Three quiet bars under `text`. */
  | { readonly kind: "searching"; readonly text: string }
  /** Rows headed "From GitHub", then `caption`, such as "2 results", and `note` when the list may be short. */
  | {
      readonly kind: "results";
      readonly heading: string;
      readonly caption: string;
      readonly rows: readonly AddRow[];
      readonly note: string | undefined;
    }
  /**
   * A sentence in place of a list. `widenLabel` adds the button that searches
   * all of the source. `lockedHint` makes it a locked thing: a lock, the
   * sentence in bold, and the hint under it.
   */
  | {
      readonly kind: "message";
      readonly text: string;
      readonly widenLabel: string | undefined;
      readonly lockedHint: string | undefined;
    };

/** Returns the view that shows `text` in place of a list. */
const buildMessageView = (
  text: string,
  extra: { readonly widenLabel?: string; readonly lockedHint?: string } = {},
): AddListView => ({
  kind: "message",
  text,
  widenLabel: extra.widenLabel,
  lockedHint: extra.lockedHint,
});

/** Returns the sentence for a source that has nothing for `text`, with the button that widens a narrowed search. */
const describeNothingFound = (
  sourceName: string,
  text: string,
  scope: ScopeOption | undefined,
): AddListView =>
  scope === undefined
    ? buildMessageView(`${sourceName} has nothing that matches "${text}".`)
    : buildMessageView(`Nothing in ${scope.title} matches "${text}".`, {
        widenLabel: `Search all of ${sourceName}`,
      });

/** Returns the view for a search the source answered. */
const decideAnsweredView = (
  reply: EntitySearchReply,
  input: {
    readonly sourceName: string;
    readonly names: ReadonlyMap<string, string>;
    readonly text: string;
    readonly isLink: boolean;
    readonly scope: ScopeOption | undefined;
  },
): AddListView => {
  const { sourceName, text, isLink, scope } = input;
  const rows = buildResultRows(reply.results);
  const shortNote = `Not every ${sourceName} account answered, so this list may be short.`;
  switch (reply.outcome) {
    case "results":
    case "incomplete":
      if (rows.length > 0) {
        return {
          kind: "results",
          heading: `From ${sourceName}`,
          caption: isLink
            ? "Found from the link"
            : `${String(rows.length)} ${rows.length === 1 ? "result" : "results"}`,
          rows,
          note: reply.incomplete || reply.outcome === "incomplete" ? shortNote : undefined,
        };
      }
      return reply.outcome === "incomplete"
        ? buildMessageView(shortNote)
        : describeNothingFound(sourceName, text, scope);
    case "no-match":
      return describeNothingFound(sourceName, text, scope);
    case "inaccessible": {
      const noun = reply.results[0]?.noun.toLowerCase() ?? "thing";
      return buildMessageView(`You cannot open this ${sourceName} ${noun}.`, {
        lockedHint: `It exists, but your connection to ${sourceName} has no access to it. Ask for access, then ${isLink ? "paste the link" : "search"} again.`,
      });
    }
    case "not-found":
    case "unknown":
      return isLink
        ? buildMessageView(
            `${sourceName} found nothing at this link. It may be wrong, or the thing may be gone.`,
          )
        : describeNothingFound(sourceName, text, scope);
    case "ambiguous":
      return buildMessageView(
        `"${text}" names different things in different workspaces of ${sourceName}. Paste its link instead.`,
      );
    case "unknown-link": {
      const readable = reply.linkSources.map((id) => input.names.get(id) ?? id).join(", ");
      return buildMessageView(
        readable === ""
          ? "This link is not from a connected source."
          : `This link is not from a connected source. Hercule can read links from ${readable}.`,
      );
    }
    case "source-unavailable":
      return buildMessageView(`${sourceName} has no connection to search. Add one in Connections.`);
  }
};

/**
 * Decides what fills the sheet's list, from the words that were searched
 * (`text`, once typing stopped) and where that search stands.
 *
 * - Nothing searched, or the sheet is offline: the suggestions. Offline, the
 *   intro leaves out "Search to reach everything else", which is no longer true.
 * - A search that has not answered: the bars. A pasted link says "Reading this
 *   link…" instead of naming a source, because the link decides which source.
 * - An answer: its results, or the one sentence its outcome calls for. Each
 *   outcome of `EntitySearchReply` has its own sentence.
 *
 * `sourceName` is the source the answer is from (the reply's `source`, once
 * it answered), `names` maps every plugin id to its name, and `scope` is the
 * context the search was narrowed to, when it was.
 */
export const decideAddList = ({
  sourceName,
  names,
  text,
  isLink,
  isOffline,
  scope,
  search,
}: {
  readonly sourceName: string;
  readonly names: ReadonlyMap<string, string>;
  readonly text: string;
  readonly isLink: boolean;
  readonly isOffline: boolean;
  readonly scope: ScopeOption | undefined;
  readonly search: SearchState;
}): AddListView => {
  if (isOffline || search.status === "idle") {
    return {
      kind: "suggestions",
      title: "Suggestions",
      text: `Things that concern you, with no Task yet.${isOffline ? "" : " Search to reach everything else."}`,
    };
  }
  switch (search.status) {
    case "pending":
      return {
        kind: "searching",
        text: isLink ? "Reading this link…" : `Searching ${sourceName}…`,
      };
    case "failed":
      return buildMessageView(`Could not search ${sourceName}. ${search.reason}`);
    case "answered":
      return decideAnsweredView(search.reply, { sourceName, names, text, isLink, scope });
  }
};

const TASK_STAGE_NAMES: Readonly<Record<TaskStage, string>> = {
  ...STAGE_NAMES,
  done: "Done",
  dropped: "Dropped",
};

/** Returns the name of a stage a Task can be at: the board's name, or "Done" or "Dropped". */
export const nameTaskStage = (stage: TaskStage): string => TASK_STAGE_NAMES[stage];

/**
 * Returns the line at the foot that reports an add: "Added to Exploring.
 * Hercule now follows WEB-301." `followed` is true when the thing has no
 * concern of its own and the new Task makes Hercule follow it. When the thing
 * already had a Task (`created` is false), nothing was added, and the line
 * says where that Task is.
 */
export const describeAddedLine = ({
  stage,
  identifier,
  followed,
  created,
}: {
  readonly stage: TaskStage;
  readonly identifier: string;
  readonly followed: boolean;
  readonly created: boolean;
}): string =>
  created
    ? `Added to ${nameTaskStage(stage)}.${followed ? ` Hercule now follows ${identifier}.` : ""}`
    : `${identifier} is already on Work, in ${nameTaskStage(stage)}.`;
