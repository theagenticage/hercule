/**
 * What the Inbox remembers about how the user looks at it, in
 * `localStorage`: what the wide side is grouped by, and how Requests are
 * ordered. One entry per controller and user, because a grouping by a kind of
 * place means nothing to another controller, and two people on one machine
 * choose their own. The filter is not kept: it is about what the user is
 * doing now.
 */
import { HOME_GROUPING, type RequestsOrder } from "@hercule/client-core/inbox";

/** What is kept. */
export interface SavedInboxView {
  /** `HOME_GROUPING`, `STATUS_GROUPING` or the word of a kind of place (`listInboxGroupings`). */
  readonly grouping: string;
  readonly requestsOrder: RequestsOrder;
}

/** The view of a user who has saved nothing: grouped by place, Requests oldest first. */
export const DEFAULT_INBOX_VIEW: SavedInboxView = {
  grouping: HOME_GROUPING,
  requestsOrder: "oldest",
};

const REQUESTS_ORDERS: readonly RequestsOrder[] = ["oldest", "mine", "place"];

/** Returns the `localStorage` key that holds the view of `username` on the controller at `controllerUrl`. */
export const buildInboxViewKey = (controllerUrl: string, username: string): string =>
  `inbox-view:${controllerUrl}:${username}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Returns the view stored under `key`. A missing, unreadable or malformed
 * entry reads as the default view, and so does each field that is not what it
 * should be, so one bad field never costs the user the other.
 */
export const readSavedInboxView = (key: string): SavedInboxView => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return DEFAULT_INBOX_VIEW;
  }
  if (!isRecord(parsed)) return DEFAULT_INBOX_VIEW;
  const { grouping, requestsOrder } = parsed;
  return {
    grouping: typeof grouping === "string" ? grouping : DEFAULT_INBOX_VIEW.grouping,
    requestsOrder:
      REQUESTS_ORDERS.find((order) => order === requestsOrder) ?? DEFAULT_INBOX_VIEW.requestsOrder,
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
