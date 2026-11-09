/**
 * What the Inbox remembers about how the user looks at it, in
 * `localStorage`: what the wide side is grouped by, which Requests are shown,
 * how the Requests column is grouped and sorted, and which of its groups are
 * folded. One entry per controller and user, because a grouping by a kind of
 * place means nothing to another controller, and two people on one machine
 * choose their own.
 *
 * The page Filter is not kept: it is about what the user is doing now. The
 * Requests choices are kept (Rogier's decision, 2026-11-09) because they
 * describe how the user likes to read the column. Folded group ids are kept
 * while the column is ungrouped too, so grouping by place again brings the
 * same groups back folded.
 */
import {
  HOME_GROUPING,
  SHOW_ALL,
  type RequestsGrouping,
  type RequestsShow,
  type RequestsSort,
} from "@hercule/client-core/inbox";

/** What is kept. */
export interface SavedInboxView {
  /** `HOME_GROUPING`, `STATUS_GROUPING` or the word of a kind of place (`listInboxGroupings`). */
  readonly grouping: string;
  readonly requestsShow: RequestsShow;
  readonly requestsGrouping: RequestsGrouping;
  readonly requestsSort: RequestsSort;
  /** The ids of the Requests groups the user folded (`RequestGroup.id`). */
  readonly collapsedGroups: readonly string[];
}

/** The view of a user who has saved nothing: grouped by place, Requests shown to all, ungrouped, oldest first. */
export const DEFAULT_INBOX_VIEW: SavedInboxView = {
  grouping: HOME_GROUPING,
  requestsShow: SHOW_ALL,
  requestsGrouping: "none",
  requestsSort: "oldest",
  collapsedGroups: [],
};

/** Returns the `localStorage` key that holds the view of `username` on the controller at `controllerUrl`. */
export const buildInboxViewKey = (controllerUrl: string, username: string): string =>
  `inbox-view:${controllerUrl}:${username}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Returns the Show choice `value` spells, or the default when it spells none. */
const parseRequestsShow = (value: unknown): RequestsShow => {
  if (!isRecord(value)) return DEFAULT_INBOX_VIEW.requestsShow;
  if (value.kind === "all") return SHOW_ALL;
  if (value.kind === "mine") return { kind: "mine" };
  if (value.kind === "person" && typeof value.name === "string" && value.name !== "") {
    return { kind: "person", name: value.name };
  }
  return DEFAULT_INBOX_VIEW.requestsShow;
};

/** Returns the grouping and the sort an older build saved as one `requestsOrder`, or `undefined` for any other value. */
const parseLegacyRequestsOrder = (
  value: unknown,
): Pick<SavedInboxView, "requestsGrouping" | "requestsSort"> | undefined => {
  // "mine" was an order that still showed everyone, so it does not become the Mine choice.
  if (value === "oldest" || value === "mine")
    return { requestsGrouping: "none", requestsSort: "oldest" };
  if (value === "place") return { requestsGrouping: "place", requestsSort: "oldest" };
  return undefined;
};

/**
 * Returns the view stored under `key`. A missing, unreadable or malformed
 * entry reads as the default view, and so does each field that is not what it
 * should be, so one bad field never costs the user the others. A grouping or
 * sort that is absent falls back to the legacy `requestsOrder` of older
 * builds. One that is present but invalid reads as the default, so the legacy
 * order never overrides a new field.
 */
export const readSavedInboxView = (key: string): SavedInboxView => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return DEFAULT_INBOX_VIEW;
  }
  if (!isRecord(parsed)) return DEFAULT_INBOX_VIEW;
  const { grouping, requestsShow, requestsGrouping, requestsSort, collapsedGroups, requestsOrder } =
    parsed;
  const legacy = parseLegacyRequestsOrder(requestsOrder);
  return {
    grouping: typeof grouping === "string" ? grouping : DEFAULT_INBOX_VIEW.grouping,
    requestsShow: parseRequestsShow(requestsShow),
    requestsGrouping:
      requestsGrouping === undefined
        ? (legacy?.requestsGrouping ?? DEFAULT_INBOX_VIEW.requestsGrouping)
        : requestsGrouping === "none" || requestsGrouping === "place"
          ? requestsGrouping
          : DEFAULT_INBOX_VIEW.requestsGrouping,
    requestsSort:
      requestsSort === undefined
        ? (legacy?.requestsSort ?? DEFAULT_INBOX_VIEW.requestsSort)
        : requestsSort === "oldest" || requestsSort === "newest"
          ? requestsSort
          : DEFAULT_INBOX_VIEW.requestsSort,
    collapsedGroups: Array.isArray(collapsedGroups)
      ? collapsedGroups.filter((id): id is string => typeof id === "string")
      : DEFAULT_INBOX_VIEW.collapsedGroups,
  };
};

/** Stores `view` under `key`. A storage that refuses it loses nothing that matters, so the failure is ignored. */
export const writeSavedInboxView = (key: string, view: SavedInboxView): void => {
  try {
    localStorage.setItem(key, JSON.stringify(view));
  } catch {
    // The storage is full or denied: the Inbox keeps the view for this window.
  }
};
