/**
 * The groups of one Inbox visit: how a group keeps its identity when a read
 * describes it again, and how the held rows and groups become the list's
 * entries (heads, members, "more" lines). Pure: every function takes values
 * and returns values. Internal to the visit (`inbox-visit-state.ts`).
 *
 * A group is a set of things linked to each other. The controller names a group
 * only in the reply that carries it, with no identity of its own, so the visit
 * mints a key (`group:1`, `group:2`, ...) and keeps it while the group's
 * members mostly stay the same. Folds (open, show more) hang on that key.
 */
import type { InboxGroupMember } from "@hercule/contract";

/** The key of a group. A thing's ref has two colons, so a group key never equals a ref. */
export type GroupKey = `group:${number}`;

/** The key of the "Show N more" line of a group. */
export type MoreKey = `${GroupKey}:more`;

/** Returns true when `key` is the key of a group's head. */
export const isGroupKey = (key: string): key is GroupKey => /^group:\d+$/.test(key);

/** A group as the visit holds it: the reply's fields plus the key the visit gave it. */
export interface HeldGroup {
  readonly key: GroupKey;
  /** The member the group is named after, and its title. */
  readonly labelRef: string;
  readonly label: string;
  /** The members that answer the list's query first, then the others, held or not. */
  readonly members: readonly InboxGroupMember[];
  /** How many members the group has. Above `members.length` only for a group of more than 1,000. */
  readonly size: number;
}

/** What the user chose for a group. A missing field means no choice: the display decides. */
export interface GroupFold {
  readonly isOpen?: boolean;
  readonly isExpanded?: boolean;
}

/** A group of this many held members or fewer shows them all when open. */
const SHOW_ALL_UP_TO = 7;
/** A larger group shows this many members until the user asks for more. */
const COLLAPSED_SHOWN = 5;

/** The group as the list draws its head. */
export interface InboxGroupView<Row> {
  readonly key: GroupKey;
  readonly labelRef: string;
  readonly label: string;
  readonly size: number;
  /** True when the group has more members than the reply listed, so some are out of reach of a move. */
  readonly isCut: boolean;
  readonly isOpen: boolean;
  /** The first held member that answers the query: its time, ask and marks draw the head. */
  readonly placedBy: Row | undefined;
  /** The held members, in member order. */
  readonly rows: readonly Row[];
  /** How many members answer the query, held or not. */
  readonly matchingCount: number;
  /** The refs of the held members that answer the query. */
  readonly matchingRefs: readonly string[];
  /** Whether the selection holds all, some or none of the group. */
  readonly tick: "none" | "some" | "all";
}

/** One line of the list. A thing, a group's head, one of its members, or its "Show N more". */
export type InboxEntry<Row> =
  | { readonly kind: "thing"; readonly key: string; readonly row: Row }
  | { readonly kind: "head"; readonly key: GroupKey; readonly group: InboxGroupView<Row> }
  | {
      readonly kind: "member";
      readonly key: string;
      readonly row: Row;
      readonly groupKey: GroupKey;
      /** From 1, among the members shown. */
      readonly position: number;
      /** How many members the visit holds. */
      readonly of: number;
      readonly answersQuery: boolean;
      /** True for the last line of the group, which ends the line that joins its members. */
      readonly isLast: boolean;
    }
  | {
      readonly kind: "more";
      readonly key: MoreKey;
      readonly groupKey: GroupKey;
      readonly hiddenCount: number;
    };

interface Placed<Row> {
  readonly group: HeldGroup;
  /** The held members, in member order. At least two. */
  readonly held: readonly Row[];
}

/**
 * Works out which held rows form a group. A group with fewer than two held
 * members is not drawn as a group. A ref in two groups belongs to the first.
 */
function placeGroups<Row extends { readonly ref: string }>(
  rows: readonly Row[],
  groups: readonly HeldGroup[],
): Map<string, Placed<Row>> {
  const rowByRef = new Map(rows.map((row) => [row.ref, row]));
  const placedByRef = new Map<string, Placed<Row>>();
  for (const group of groups) {
    const held = group.members.flatMap((member) => {
      const row = rowByRef.get(member.ref);
      return row === undefined || placedByRef.has(member.ref) ? [] : [row];
    });
    if (held.length < 2) continue;
    const placed = { group, held };
    for (const row of held) placedByRef.set(row.ref, placed);
  }
  return placedByRef;
}

/**
 * Returns `rows` with each group's held members next to each other: the group
 * stands where its first held member stands and the others follow it in member
 * order. The order of everything else is kept.
 */
export function gatherGroupRows<Row extends { readonly ref: string }>(
  rows: readonly Row[],
  groups: readonly HeldGroup[],
): Row[] {
  const placedByRef = placeGroups(rows, groups);
  if (placedByRef.size === 0) return [...rows];
  const gathered = new Set<GroupKey>();
  return rows.flatMap((row) => {
    const placed = placedByRef.get(row.ref);
    if (placed === undefined) return [row];
    if (gathered.has(placed.group.key)) return [];
    gathered.add(placed.group.key);
    return placed.held;
  });
}

/**
 * Builds the entries the list draws, in order. A group with two or more held
 * members draws a head and, when open, its members; the others are things.
 *
 * - A group is open when the user opened it. With no choice, it is open in a
 *   search when a member other than its label answers the query, so a hit
 *   inside a group is not hidden behind its head.
 * - An open group of more than 7 held members shows its first 5 (the members
 *   that answer the query come first) and a "more" line, until expanded.
 */
export function buildEntries<Row extends { readonly ref: string }>(input: {
  readonly rows: readonly Row[];
  readonly groups: readonly HeldGroup[];
  readonly folds: ReadonlyMap<GroupKey, GroupFold>;
  readonly isSearch: boolean;
  readonly selection: ReadonlySet<string>;
}): InboxEntry<Row>[] {
  const placedByRef = placeGroups(input.rows, input.groups);
  const drawn = new Set<GroupKey>();
  const entries: InboxEntry<Row>[] = [];
  for (const row of input.rows) {
    const placed = placedByRef.get(row.ref);
    if (placed === undefined) {
      entries.push({ kind: "thing", key: row.ref, row });
      continue;
    }
    if (drawn.has(placed.group.key)) continue;
    drawn.add(placed.group.key);
    pushGroup(entries, placed, input.folds.get(placed.group.key), input);
  }
  return entries;
}

function pushGroup<Row extends { readonly ref: string }>(
  entries: InboxEntry<Row>[],
  { group, held }: Placed<Row>,
  fold: GroupFold | undefined,
  input: { readonly isSearch: boolean; readonly selection: ReadonlySet<string> },
): void {
  const matches = new Map(group.members.map((member) => [member.ref, member.matches]));
  const matchingRows = held.filter((row) => matches.get(row.ref) === true);
  const isOpen =
    fold?.isOpen ??
    (input.isSearch &&
      group.members.some((member) => member.matches && member.ref !== group.labelRef));
  const selected = held.filter((row) => input.selection.has(row.ref));
  const isEveryMatchSelected =
    matchingRows.length > 0 && matchingRows.every((row) => input.selection.has(row.ref));
  entries.push({
    kind: "head",
    key: group.key,
    group: {
      key: group.key,
      labelRef: group.labelRef,
      label: group.label,
      size: group.size,
      isCut: group.size > group.members.length,
      isOpen,
      placedBy: matchingRows[0],
      rows: held,
      matchingCount: group.members.filter((member) => member.matches).length,
      matchingRefs: matchingRows.map((row) => row.ref),
      tick: isEveryMatchSelected ? "all" : selected.length > 0 ? "some" : "none",
    },
  });
  if (!isOpen) return;
  const shown =
    held.length <= SHOW_ALL_UP_TO || fold?.isExpanded === true
      ? held
      : held.slice(0, COLLAPSED_SHOWN);
  const hiddenCount = held.length - shown.length;
  shown.forEach((row, index) => {
    entries.push({
      kind: "member",
      key: row.ref,
      row,
      groupKey: group.key,
      position: index + 1,
      of: held.length,
      answersQuery: matches.get(row.ref) === true,
      isLast: hiddenCount === 0 && index === shown.length - 1,
    });
  });
  if (hiddenCount > 0) {
    entries.push({ kind: "more", key: `${group.key}:more`, groupKey: group.key, hiddenCount });
  }
}

/**
 * Returns the refs a selection acts on for `entry`: a head's held members that
 * answer the query, a thing's or a member's own ref, and nothing for a "more" line.
 */
export function entryRefs(entry: InboxEntry<{ readonly ref: string }>): readonly string[] {
  switch (entry.kind) {
    case "head":
      return entry.group.matchingRefs;
    case "thing":
    case "member":
      return [entry.row.ref];
    case "more":
      return [];
  }
}

/**
 * Returns the refs of every row `entry` stands for, aligned with `entries`: a
 * head and its "more" line stand for all the held members of the group.
 */
export function listEntryRows(
  entries: readonly InboxEntry<{ readonly ref: string }>[],
): (readonly string[])[] {
  const rowsOfGroup = new Map<GroupKey, readonly string[]>();
  for (const entry of entries) {
    if (entry.kind === "head")
      rowsOfGroup.set(
        entry.key,
        entry.group.rows.map((row) => row.ref),
      );
  }
  return entries.map((entry) => {
    if (entry.kind === "head") return rowsOfGroup.get(entry.key) ?? [];
    if (entry.kind === "more") return rowsOfGroup.get(entry.groupKey) ?? [];
    return [entry.row.ref];
  });
}

/**
 * Returns the key of the entry that shows `ref`: the entry with that key (a
 * thing, a member, a head, a "more" line), else the head of the group that holds it (a closed group, or a member
 * behind "Show N more"). Returns `null` when no entry shows it.
 */
export function findEntryKey(
  entries: readonly InboxEntry<{ readonly ref: string }>[],
  ref: string,
): string | null {
  const own = entries.find((entry) => entry.key === ref);
  if (own !== undefined) return own.key;
  for (const entry of entries) {
    if (entry.kind === "head" && entry.group.rows.some((row) => row.ref === ref)) return entry.key;
  }
  return null;
}

/**
 * Returns the entry key to keep as current (or anchor) after the entries
 * changed from `oldKeys` to `newEntries`, or `null` when nothing is left. The
 * first rule that fits:
 * 1. `key` is still an entry: keep it.
 * 2. `key` is a thing a fold now hides, or a member a read pulled into a group:
 *    the entry that shows it.
 * 3. `key` is a head or "more" line whose group dissolved: the first of its old
 *    members that is still an entry. A "more" line whose head remains: the head.
 * 4. The entry after it in the old order, else the one before, else the first.
 */
export function settleKey(
  oldKeys: readonly string[],
  newEntries: readonly InboxEntry<{ readonly ref: string }>[],
  key: string,
  oldGroups: readonly HeldGroup[],
): string | null {
  const newKeys = new Set(newEntries.map((entry) => entry.key));
  if (newKeys.has(key)) return key;
  const shown = findEntryKey(newEntries, key);
  if (shown !== null) return shown;
  const groupKey = key.endsWith(":more") ? key.slice(0, -":more".length) : key;
  if (isGroupKey(groupKey)) {
    if (newKeys.has(groupKey)) return groupKey;
    const members = oldGroups.find((group) => group.key === groupKey)?.members ?? [];
    const survivor = members.find((member) => newKeys.has(member.ref));
    if (survivor !== undefined) return survivor.ref;
  }
  const at = oldKeys.indexOf(key);
  if (at >= 0) {
    const neighbour =
      oldKeys.slice(at + 1).find((other) => newKeys.has(other)) ??
      oldKeys
        .slice(0, at)
        .reverse()
        .find((other) => newKeys.has(other));
    if (neighbour !== undefined) return neighbour;
  }
  return newEntries[0]?.key ?? null;
}

/** Returns `groups` without the members in `removed`. A group left with fewer than two members is dropped. */
export function removeMembers(
  groups: readonly HeldGroup[],
  removed: ReadonlySet<string>,
): readonly HeldGroup[] {
  if (removed.size === 0) return groups;
  return groups.flatMap((group) => {
    const members = group.members.filter((member) => !removed.has(member.ref));
    if (members.length === group.members.length) return [group];
    if (members.length < 2) return [];
    return [{ ...group, members, size: group.size - (group.members.length - members.length) }];
  });
}

/** A group a reply describes, before it has a key: `HeldGroup` less the key. */
export type IncomingGroup = Omit<HeldGroup, "key">;

/**
 * Matches the groups a read describes to the groups the visit holds, so a group
 * keeps its key (and its folds) while its members change.
 *
 * - Overlap is counted on member refs. The incoming group and held group with
 *   the most refs in common are paired first, then the next most, each group in
 *   one pair at most. A tie goes to the held group of the current row, then to
 *   the first held group.
 * - An incoming group with no pair gets a fresh key. It inherits the folds of
 *   the held group it overlaps most (`inherit`), even when that group's key went
 *   to another: a group that splits keeps both parts open.
 * - A held group that no incoming group took stays, less the members the read
 *   `covered` (they are in another group or alone now). It is dropped when fewer
 *   than two members are left, so a group the read did not mention is kept.
 * - An incoming group of fewer than two members is not a group.
 *
 * Returns the groups in the order: incoming first, then the ones kept.
 */
export function reconcileGroups(input: {
  readonly previous: readonly HeldGroup[];
  readonly incoming: readonly IncomingGroup[];
  readonly covered: ReadonlySet<string>;
  readonly nextNumber: number;
  readonly currentGroup: GroupKey | null;
}): {
  readonly groups: HeldGroup[];
  readonly nextNumber: number;
  readonly inherit: ReadonlyMap<GroupKey, GroupKey>;
} {
  const { previous, covered } = input;
  const incoming = input.incoming.filter((group) => group.members.length >= 2);
  const previousRefs = previous.map((group) => new Set(group.members.map((m) => m.ref)));
  const pairs: { incoming: number; previous: number; overlap: number }[] = [];
  incoming.forEach((group, i) =>
    previousRefs.forEach((refs, j) => {
      const overlap = group.members.filter((member) => refs.has(member.ref)).length;
      if (overlap > 0) pairs.push({ incoming: i, previous: j, overlap });
    }),
  );
  const isCurrent = (pair: { previous: number }) =>
    previous[pair.previous]!.key === input.currentGroup ? 0 : 1;
  pairs.sort(
    (a, b) =>
      b.overlap - a.overlap ||
      isCurrent(a) - isCurrent(b) ||
      a.previous - b.previous ||
      a.incoming - b.incoming,
  );
  const takenBy = new Map<number, number>();
  const taken = new Set<number>();
  for (const pair of pairs) {
    if (takenBy.has(pair.incoming) || taken.has(pair.previous)) continue;
    takenBy.set(pair.incoming, pair.previous);
    taken.add(pair.previous);
  }

  let nextNumber = input.nextNumber;
  const inherit = new Map<GroupKey, GroupKey>();
  const groups: HeldGroup[] = incoming.map((group, i) => {
    const claimed = takenBy.get(i);
    if (claimed !== undefined) return { ...group, key: previous[claimed]!.key };
    const key: GroupKey = `group:${nextNumber}`;
    nextNumber += 1;
    const parent = pairs.find((pair) => pair.incoming === i);
    if (parent !== undefined) inherit.set(key, previous[parent.previous]!.key);
    return { ...group, key };
  });
  previous.forEach((group, j) => {
    if (taken.has(j)) return;
    groups.push(...removeMembers([group], covered));
  });
  return { groups, nextNumber, inherit };
}
