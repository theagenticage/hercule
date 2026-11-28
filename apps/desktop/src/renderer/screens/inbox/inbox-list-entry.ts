import type {
  InboxEntry,
  InboxGroupRowView,
  InboxGroupView,
  InboxRowView,
} from "@hercule/client-core/inbox";
import type { InboxRowMember } from "./inbox-row";

/** The entry of the visit (`InboxEntry`) of the kind `Kind`. */
type EntryOfKind<Kind extends InboxEntry<unknown>["kind"]> = Extract<
  InboxEntry<unknown>,
  { readonly kind: Kind }
>;

/**
 * One line of the Inbox list: the visit's entry (`InboxEntry`), with its row
 * or its group replaced by what the line draws, decided as values.
 *
 * - `thing`: a thing on its own.
 * - `member`: a thing inside an open group, with its place in the group.
 * - `head`: the row of a group of linked things; `tick` says how much of the
 *   group the selection holds.
 * - `more`: the "Show N more" line of a large group, as the visit gives it.
 *
 * The key is what the visit calls the line. It is what `data-ref` holds in the page.
 */
export type InboxListEntry =
  | (Pick<EntryOfKind<"thing">, "kind" | "key"> & { readonly view: InboxRowView })
  | (Pick<EntryOfKind<"member">, "kind" | "key"> & {
      readonly view: InboxRowView;
      readonly member: InboxRowMember;
    })
  | (Pick<EntryOfKind<"head">, "kind" | "key"> &
      Pick<InboxGroupView<unknown>, "isOpen" | "tick" | "unloadedCount"> & {
        readonly view: InboxGroupRowView;
      })
  | EntryOfKind<"more">;
