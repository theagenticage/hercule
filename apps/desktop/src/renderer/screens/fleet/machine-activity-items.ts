import type {
  MachineActivityDay,
  MachineActivityDetail,
  MachineActivityEntry,
} from "@hercule/client-core/machine-activity";

/**
 * One line of the Activity page's list. The list is flat so that it can be
 * virtualized: a day's heading, an entry, and the details of an entry that
 * the user unfolded are each a line of their own, at a height the list knows.
 */
export type MachineActivityItem =
  | { readonly kind: "day"; readonly key: string; readonly heading: string }
  | {
      readonly kind: "entry";
      readonly key: string;
      readonly entry: MachineActivityEntry;
      /** True when the entry has details and they are listed below it. */
      readonly isOpen: boolean;
      /** True when the line above is an entry or a detail, so the thread that joins the dots runs into this one. */
      readonly joinsAbove: boolean;
    }
  | {
      readonly kind: "detail";
      readonly key: string;
      readonly detail: MachineActivityDetail;
      /** True for the last detail of an unfolded entry, which has room below it before the next entry. */
      readonly isLast: boolean;
    };

/** Returns the key of the line for the entry with the key `entryKey`. */
export const buildEntryItemKey = (entryKey: string): string => `entry:${entryKey}`;

/**
 * Returns the lines of `days` in the order they are drawn: each day's heading,
 * then its entries, with the details of every entry whose key is in
 * `openEntryKeys` right after it. Only an entry with details can be open.
 */
export const buildMachineActivityItems = (
  days: ReadonlyArray<MachineActivityDay>,
  openEntryKeys: ReadonlySet<string>,
): ReadonlyArray<MachineActivityItem> => {
  const items: MachineActivityItem[] = [];
  for (const day of days) {
    items.push({ kind: "day", key: `day:${day.key}`, heading: day.heading });
    day.entries.forEach((entry, index) => {
      const isOpen = entry.details.length > 0 && openEntryKeys.has(entry.key);
      items.push({
        kind: "entry",
        key: buildEntryItemKey(entry.key),
        entry,
        isOpen,
        joinsAbove: index > 0,
      });
      if (!isOpen) return;
      entry.details.forEach((detail, detailIndex) => {
        items.push({
          kind: "detail",
          key: `detail:${entry.key}:${String(detail.eventId)}`,
          detail,
          isLast: detailIndex === entry.details.length - 1,
        });
      });
    });
  }
  return items;
};
