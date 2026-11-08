import {
  listBundleCardIds,
  type CardBundle,
  type HandedWorkflow,
} from "@hercule/client-core/inbox";
import type { InboxCard, WorkflowOffer } from "@hercule/contract";

/**
 * What the cards need to draw a hand-off: the workflows each card can be
 * handed to (`offerSets`, as `Inbox.offerSets` holds them) and, for the cards
 * the user handed off in this visit, the colleague who has each one.
 */
export interface CardHandOffs {
  readonly offerSets: Readonly<Record<string, readonly WorkflowOffer[]>>;
  readonly handed: ReadonlyMap<string, HandedWorkflow>;
}

/** The props a row and a request are both drawn from, and that need more than identity to compare. */
interface BundledCardProps {
  readonly card: InboxCard;
  readonly bundle: CardBundle;
  /** The cards a signal just landed on. A card shows the new mark when its id is in it. */
  readonly freshIds: ReadonlySet<string>;
  readonly handOffs: CardHandOffs;
}

/**
 * Checks whether `freshIds` marks the same cards of this card, and of the
 * parts under it, as it did. `ids` are those cards' ids.
 */
const isSameFreshness = (
  before: BundledCardProps,
  after: BundledCardProps,
  ids: readonly string[],
): boolean => ids.every((id) => before.freshIds.has(id) === after.freshIds.has(id));

/**
 * Checks whether the hand-offs mean the same for this card, and for the parts
 * under it, as they did: the same offers for each card that draws a Hand to
 * move (this card and its asking parts), and the same colleague on each of
 * `ids`. A card handed off elsewhere, or a workflow edited that this card is
 * not offered, does not draw this one again.
 */
const isSameHandOffs = (
  before: BundledCardProps,
  after: BundledCardProps,
  ids: readonly string[],
): boolean =>
  [
    after.card,
    ...after.bundle.parts.flatMap((part) => (part._tag === "asking" ? [part.card] : [])),
  ].every(
    ({ offerSetId }) =>
      before.handOffs.offerSets[offerSetId] === after.handOffs.offerSets[offerSetId],
  ) && ids.every((id) => before.handOffs.handed.get(id) === after.handOffs.handed.get(id));

/**
 * Returns the comparison `memo` uses to decide whether a row or a request
 * draws the same as before. The layout keeps the identity of a bundle that
 * did not change, so `bundle` is compared by identity like every other prop.
 * `freshIds` and `handOffs` are compared by the cards of this card alone, so a
 * signal landing on, or a hand-off of, another card does not draw this one
 * again. A prop named in `compare` is compared by that function.
 */
export const buildCardPropsComparer =
  <Props extends BundledCardProps>(
    compare: { readonly [Key in keyof Props]?: (before: Props, after: Props) => boolean } = {},
  ) =>
  (before: Props, after: Props): boolean => {
    // Read at most once per comparison, and only if a prop reaches it.
    let ids: readonly string[] | undefined;
    const readIds = (): readonly string[] => (ids ??= listBundleCardIds(after.card, after.bundle));
    return (Object.keys(after) as (keyof Props)[]).every((key) => {
      if (key === "freshIds") return isSameFreshness(before, after, readIds());
      if (key === "handOffs") return isSameHandOffs(before, after, readIds());
      return compare[key]?.(before, after) ?? Object.is(before[key], after[key]);
    });
  };
