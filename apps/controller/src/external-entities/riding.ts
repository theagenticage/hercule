/**
 * Riding: which small things on the Inbox ride on which lasting thing.
 *
 * A compact thing, such as a pull request, rides on a rich one, such as the
 * ticket it belongs to, when the two have a direct link that a source
 * reports or a person made. The client draws a rider as a row set in under
 * its lead. The Inbox page and the Inbox counts both ask this module, so they
 * cannot disagree about who rides.
 */
import type { EntityLink } from "@hercule/contract";

/** The fields of a card that decide riding. A lean read supplies them without reading whole cards. */
export interface RidingCard {
  readonly ref: string;
  readonly card: "rich" | "compact";
  readonly pace: "fast" | "slow";
  /** The hours before a wait counts as due, as the kind declares it. */
  readonly patience: number;
  /** When the wait began: `waitingSince`, else the first concern, else the first observation. */
  readonly waitingSince: string;
  /** True when a live Task holds the thing. Its wait has ended. */
  readonly hasTask: boolean;
}

/** The part of a link that decides riding: its two ends and the type of its firmest claim. */
export interface RidingLink {
  readonly fromRef: string;
  readonly toRef: string;
  readonly claim: { readonly type: EntityLink["claim"]["type"] };
}

const HOUR_MS = 3_600_000;

/**
 * Returns how much of its patience a thing's wait has used, as a ratio: 0.5
 * is half the patience, 3 is three times it. It is the same measure the card
 * draws as its wait (`describeCardWait` in client-core). A thing with no clock
 * has used none: a kind with `pace: slow`, or a thing a live Task holds.
 */
const measurePatienceUsed = (card: RidingCard, nowMs: number): number => {
  if (card.pace !== "fast" || card.hasTask) return 0;
  const waitedMs = nowMs - Date.parse(card.waitingSince);
  if (!Number.isFinite(waitedMs) || waitedMs <= 0) return 0;
  return waitedMs / HOUR_MS / Math.max(1, card.patience);
};

/**
 * Decides which compact thing rides on which rich one, and returns a map from
 * the ref of each rider to the ref of its lead.
 *
 * - A compact thing rides when it has no live Task, so it is a Requests
 *   card, and it has a direct link to a rich thing that is among `cards`
 *   whose firmest claim is `source` or `person`. A `text` claim is a hint and
 *   joins nothing. A compact thing a live Task holds stays on the
 *   with-someone-else side and never rides: its link shows as a quiet row on
 *   the lead.
 * - With several such rich things, it rides on the most pressing: the one
 *   that has used the largest share of its patience at `nowMs`
 *   (`measurePatienceUsed`), then the lowest ref.
 * - Two rich things never ride on each other, two compact things never ride
 *   on each other, and only a direct link counts, so a chain A to B to C
 *   joins only what touches the lead.
 * - Sharing a repository or a project is not a link, so it joins nothing.
 *
 * `cards` must hold every card that can be a lead or a rider, so that a
 * dismissed thing, which is not among them, leads nothing. A compact thing
 * with no entry in the result stays on its own.
 *
 * Every rider has no live Task, so it lies on the Requests side. The Requests
 * count therefore drops by the size of the result.
 */
export const decideRiding = (
  cards: ReadonlyArray<RidingCard>,
  links: ReadonlyArray<RidingLink>,
  nowMs: number,
): ReadonlyMap<string, string> => {
  const byRef = new Map(cards.map((card) => [card.ref, card] as const));
  const leadsByRider = new Map<string, Map<string, number>>();
  const addLead = (rider: RidingCard, lead: RidingCard) => {
    const leads = leadsByRider.get(rider.ref) ?? new Map<string, number>();
    leads.set(lead.ref, measurePatienceUsed(lead, nowMs));
    leadsByRider.set(rider.ref, leads);
  };
  for (const link of links) {
    if (link.claim.type === "text") continue;
    const from = byRef.get(link.fromRef);
    const to = byRef.get(link.toRef);
    if (from === undefined || to === undefined) continue;
    if (from.card === "compact" && to.card === "rich" && !from.hasTask) addLead(from, to);
    else if (from.card === "rich" && to.card === "compact" && !to.hasTask) addLead(to, from);
  }

  const riding = new Map<string, string>();
  for (const [riderRef, leads] of leadsByRider) {
    const [mostPressing] = [...leads].sort(
      ([leftRef, leftUsed], [rightRef, rightUsed]) =>
        rightUsed - leftUsed || (leftRef < rightRef ? -1 : leftRef > rightRef ? 1 : 0),
    );
    riding.set(riderRef, mostPressing![0]);
  }
  return riding;
};

/** What `selectInboxPage` picks: the refs on the page, and whether any card was left off it. */
export interface InboxPageSelection {
  readonly refs: ReadonlySet<string>;
  readonly truncated: boolean;
}

/**
 * Picks the cards of one Inbox page, at most `limit`, from `refs`, the refs
 * of every eligible card in page order (oldest first).
 *
 * Cards are chosen in bundles. A lead brings its riders, and a rider is never
 * chosen alone, because a rider that comes without its lead would be drawn as
 * a Requests card the counts left out. The walk goes through `refs` in order
 * and takes the next lead (or lone card) with all its riders, and stops at
 * the first bundle that does not fit in the room left. When the very first
 * bundle is larger than `limit` it is cut to `limit`, the lead and its oldest
 * riders, because stopping before it would leave the page empty for good.
 *
 * `riding` is the rider to lead map from `decideRiding`. Every lead in it is
 * among `refs`.
 */
export const selectInboxPage = (
  refs: ReadonlyArray<string>,
  riding: ReadonlyMap<string, string>,
  limit: number,
): InboxPageSelection => {
  const ridersByLead = new Map<string, Array<string>>();
  for (const ref of refs) {
    const lead = riding.get(ref);
    if (lead !== undefined) ridersByLead.set(lead, [...(ridersByLead.get(lead) ?? []), ref]);
  }
  const selected = new Set<string>();
  for (const ref of refs) {
    if (riding.has(ref)) continue;
    const bundle = [ref, ...(ridersByLead.get(ref) ?? [])];
    if (selected.size + bundle.length > limit) {
      if (selected.size === 0) for (const member of bundle.slice(0, limit)) selected.add(member);
      break;
    }
    for (const member of bundle) selected.add(member);
  }
  return { refs: selected, truncated: selected.size < refs.length };
};
