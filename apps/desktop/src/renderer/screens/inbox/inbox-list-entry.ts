import type { GroupKey, InboxGroupRowView, InboxRowView } from "@hercule/client-core/inbox";

/**
 * One line of the Inbox list, with everything it draws decided as values.
 *
 * - `thing`: a thing on its own.
 * - `head`: the row of a group of linked things; `tick` says how much of the
 *   group the selection holds.
 * - `member`: a thing inside an open group. `isQuiet` is true when it does not
 *   answer the list's query, `isLast` when it ends the line that joins the group's members.
 * - `more`: the "Show N more" line of a large group.
 *
 * The key is what the visit calls the line: a thing's ref, a group's key, or
 * the group's "more" key. It is what `data-ref` holds in the page.
 */
export type InboxListEntry =
  | { readonly kind: "thing"; readonly key: string; readonly view: InboxRowView }
  | {
      readonly kind: "member";
      readonly key: string;
      readonly view: InboxRowView;
      readonly member: { readonly isQuiet: boolean; readonly isLast: boolean };
    }
  | {
      readonly kind: "head";
      readonly key: GroupKey;
      readonly view: InboxGroupRowView;
      readonly isOpen: boolean;
      readonly tick: "none" | "some" | "all";
    }
  | {
      readonly kind: "more";
      readonly key: string;
      readonly groupKey: GroupKey;
      readonly hiddenCount: number;
    };
