import { listBundleCardIds, type CardBundle } from "@hercule/client-core/inbox";
import type { InboxCard } from "@hercule/contract";

/** The props a row and a request are both drawn from, and that need more than identity to compare. */
interface BundledCardProps {
  readonly card: InboxCard;
  readonly bundle: CardBundle;
  /** The cards a signal just landed on. A card shows the new mark when its id is in it. */
  readonly freshIds: ReadonlySet<string>;
}

/** Checks whether `freshIds` marks the same cards of this card, and of the parts under it, as it did. */
const isSameFreshness = (before: BundledCardProps, after: BundledCardProps): boolean =>
  listBundleCardIds(after.card, after.bundle).every(
    (id) => before.freshIds.has(id) === after.freshIds.has(id),
  );

/**
 * Returns the comparison `memo` uses to decide whether a row or a request
 * draws the same as before. The layout keeps the identity of a bundle that
 * did not change, so `bundle` is compared by identity like every other prop.
 * `freshIds` is compared by the cards of this card alone, so a signal landing
 * on another card does not draw this one again. A prop named in `compare` is
 * compared by that function.
 */
export const buildCardPropsComparer =
  <Props extends BundledCardProps>(
    compare: { readonly [Key in keyof Props]?: (before: Props, after: Props) => boolean } = {},
  ) =>
  (before: Props, after: Props): boolean =>
    (Object.keys(after) as (keyof Props)[]).every((key) => {
      if (key === "freshIds") return isSameFreshness(before, after);
      return compare[key]?.(before, after) ?? Object.is(before[key], after[key]);
    });
