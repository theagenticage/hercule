/**
 * Groups on the Inbox: which things are linked into one group, how a group is
 * named, and how a page of the Inbox is cut into units.
 *
 * A group is a connected component of the things on the Inbox, joined by the
 * links a source or a person made. This module is pure: the statements that
 * read the links and place the units are in `inbox-query.ts`.
 *
 * A unit is what a page is made of: a whole group, or a thing that is in no
 * group. A unit's key is the ref of its label thing (a group) or its own ref
 * (a lone thing). Both are refs of a thing on the Inbox, so keys never clash.
 */
import { MAX_INBOX_MOVED_THINGS, type InboxGroup, type InboxGroupMember } from "@hercule/contract";

/** What electing the label of a group needs to know about a thing on the Inbox. */
export interface GroupCandidate {
  readonly ref: string;
  /** The qualified kind. Its `lasting` is looked up in `decideGroups`. */
  readonly kind: string;
  readonly title: string;
  /** When the thing was created at its source, else when it was first observed. An ISO time. */
  readonly createdAt: string;
}

/** A link between two things, by the refs of its ends. */
export interface GroupLink {
  readonly fromRef: string;
  readonly toRef: string;
}

/** A group of at least two things on the Inbox. */
export interface Group {
  /** The label thing, which is also the key of the group's unit. */
  readonly labelRef: string;
  /** The title of the label thing. */
  readonly label: string;
  /** Every member, the label thing included, sorted by ref. The list's order is applied by the reader. */
  readonly memberRefs: ReadonlyArray<string>;
}

/** The group of each thing that is in one. A thing in no group is not a key. */
export type GroupsByRef = ReadonlyMap<string, Group>;

/**
 * Decides the groups among `things`, the things on the Inbox that have a link.
 *
 * - Two things are in one group when `links` join them directly or through
 *   other members. A link with an end that is not in `things` joins nothing,
 *   so a thing that is not on the Inbox never bridges two groups.
 * - A thing that no link joins to another thing is in no group.
 * - The label thing is the member whose kind has the highest `lasting` (a kind
 *   that is not in `lasting` counts 0), then the oldest, then the lowest ref.
 *
 * Returns the group of every thing that is in one.
 */
export const decideGroups = (
  things: ReadonlyArray<GroupCandidate>,
  links: ReadonlyArray<GroupLink>,
  lasting: ReadonlyMap<string, number>,
): GroupsByRef => {
  const byRef = new Map(things.map((thing) => [thing.ref, thing] as const));
  const parent = new Map<string, string>();
  const findRoot = (ref: string): string => {
    let root = ref;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // Point every ref on the way at the root, so later lookups are short.
    let step = ref;
    while (step !== root) {
      const next = parent.get(step)!;
      parent.set(step, root);
      step = next;
    }
    return root;
  };
  for (const link of links) {
    if (link.fromRef === link.toRef || !byRef.has(link.fromRef) || !byRef.has(link.toRef)) continue;
    for (const ref of [link.fromRef, link.toRef]) if (!parent.has(ref)) parent.set(ref, ref);
    parent.set(findRoot(link.fromRef), findRoot(link.toRef));
  }

  const membersByRoot = new Map<string, Array<GroupCandidate>>();
  for (const ref of parent.keys()) {
    const root = findRoot(ref);
    const members = membersByRoot.get(root) ?? [];
    members.push(byRef.get(ref)!);
    membersByRoot.set(root, members);
  }

  const groups = new Map<string, Group>();
  for (const members of membersByRoot.values()) {
    const label = members.reduce((best, member) =>
      isBetterLabel(member, best, lasting) ? member : best,
    );
    const group: Group = {
      labelRef: label.ref,
      label: label.title,
      memberRefs: members.map((member) => member.ref).sort(compareRefs),
    };
    for (const ref of group.memberRefs) groups.set(ref, group);
  }
  return groups;
};

const compareRefs = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** Checks that `candidate` is a better label than `best`: more lasting, then older, then a lower ref. */
const isBetterLabel = (
  candidate: GroupCandidate,
  best: GroupCandidate,
  lasting: ReadonlyMap<string, number>,
): boolean => {
  const candidateLasting = lasting.get(candidate.kind) ?? 0;
  const bestLasting = lasting.get(best.kind) ?? 0;
  if (candidateLasting !== bestLasting) return candidateLasting > bestLasting;
  if (candidate.createdAt !== best.createdAt) return candidate.createdAt < best.createdAt;
  return candidate.ref < best.ref;
};

/** Returns the key of the unit `ref` is in: the label ref of its group, or `ref` itself when it is in none. */
export const findUnitKey = (groups: GroupsByRef, ref: string): string =>
  groups.get(ref)?.labelRef ?? ref;

/** A unit as the page cut sees it: its key and how many things it holds. */
export interface PageUnit {
  readonly key: string;
  readonly size: number;
}

/** The units a page keeps, and how many things of each go on the page. */
export interface PageCut<Unit extends PageUnit> {
  readonly kept: ReadonlyArray<{ readonly unit: Unit; readonly take: number }>;
  /** True when units were left for a later page. */
  readonly more: boolean;
}

/**
 * Cuts a page from `units`, in list order, to hold at most `budget` things.
 *
 * - Whole units are taken while they fit, and the cut stops at the first unit
 *   that does not fit, so a later small unit never jumps ahead of it.
 * - When the very first unit alone is larger than `budget`, it is cut to
 *   `budget` things (`take`) and the page still moves past all of it. Stopping
 *   before it would leave every page empty.
 */
export const cutPage = <Unit extends PageUnit>(
  units: ReadonlyArray<Unit>,
  budget: number,
): PageCut<Unit> => {
  const kept: Array<{ unit: Unit; take: number }> = [];
  let used = 0;
  for (const unit of units) {
    if (used + unit.size > budget) {
      if (kept.length === 0) kept.push({ unit, take: budget });
      break;
    }
    kept.push({ unit, take: unit.size });
    used += unit.size;
  }
  return { kept, more: kept.length < units.length };
};

/**
 * Builds the `InboxGroup` of a reply from the members of `group`, given in the
 * list's order with whether each answers the query. The members that answer
 * come first, then the others, each part keeping the list's order, so the
 * first member is the one that places the group. The list is cut to
 * `MAX_INBOX_MOVED_THINGS`; `size` stays the full count.
 */
export const buildInboxGroup = (
  group: Group,
  members: ReadonlyArray<InboxGroupMember>,
): InboxGroup => ({
  labelRef: group.labelRef,
  label: group.label,
  members: [
    ...members.filter((member) => member.matches),
    ...members.filter((member) => !member.matches),
  ].slice(0, MAX_INBOX_MOVED_THINGS),
  size: members.length,
});
