/**
 * Small words about an External Entity that both Overview pages draw: which
 * plugin owns a kind, and how a target date reads.
 */
import { parsePluginId } from "../plugin-id";

/**
 * Returns the id of the plugin that owns `kind`, such as `github` for
 * `github/pull-request`, so a screen can draw that plugin's mark. A kind is
 * always qualified with its plugin's id. A word that is not returns itself,
 * so a mark is still drawn (as the first letter of that word).
 */
export const readEntityPluginId = (kind: string): string => parsePluginId(kind) ?? kind;

const TARGET_DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

/**
 * Returns a target or due date as "14 Nov". The day is read in UTC because a
 * target date names a calendar day: reading it in the user's zone would show
 * the day before for a user west of Greenwich. `at` is an ISO timestamp.
 */
export const formatTargetDate = (at: string): string => TARGET_DATE_FORMAT.format(new Date(at));
