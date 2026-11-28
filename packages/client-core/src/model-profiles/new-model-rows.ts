/**
 * The "New" rows of an account's section: the models the controller announces
 * as new (spec 06 §17.5). The composer's menu and the Providers page's Models
 * page draw the same rows, so both build them here, with the same words.
 */
import type { ResolvedModelProfileAccount } from "@hercule/contract";
import { formatDay, readCalendarDate } from "../time-context";

/** One announced model, as its row draws it: "New · Opus 5.6 · arrived 26 Oct". */
export interface NewModelRow {
  readonly providerAccountId: string;
  readonly model: string;
  /** The model's name in the account's Model Catalog. */
  readonly name: string;
  /** When the model arrived, such as "arrived 26 Oct", or "arrived 26 Oct 2025" in another year than now's. */
  readonly arrivalText: string;
}

/** When "now" is and which zone the dates are read in. */
export interface NewModelDates {
  readonly now: Date;
  readonly timezone: string;
}

/**
 * Returns "arrived 26 Oct" for an instant in the year of `now`, and
 * "arrived 26 Oct 2025" for one in another year. Returns "arrived" alone when
 * the instant or the zone cannot be formatted, because there is no date to show.
 */
const describeArrival = (arrivedAt: Date, { now, timezone }: NewModelDates): string => {
  const day = formatDay(arrivedAt, timezone);
  const year = readCalendarDate(arrivedAt, timezone)?.year;
  if (day === undefined || year === undefined) return "arrived";
  return year === readCalendarDate(now, timezone)?.year
    ? `arrived ${day}`
    : `arrived ${day} ${String(year)}`;
};

/** Returns the rows of the models `section` announces as new, in the order the controller sent them. */
export const buildNewModelRows = (
  section: ResolvedModelProfileAccount,
  dates: NewModelDates,
): readonly NewModelRow[] =>
  section.newModels.map((each) => ({
    providerAccountId: section.providerAccountId,
    model: each.model,
    name: each.name,
    arrivalText: describeArrival(new Date(each.firstSeenAt), dates),
  }));
