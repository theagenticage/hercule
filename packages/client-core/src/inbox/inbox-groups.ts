/**
 * The groups of one Inbox visit: how a group keeps its identity when a read
 * describes it again, and how the held rows and groups become the list's
 * entries (heads, members, "more" lines). Pure: every function takes values
 * and returns values. Internal to the visit (`inbox-visit-state.ts`).
 *
 * A group is a set of things linked to each other. The controller names a group
 * only in the reply that carries it, with no identity of its own, so the visit
 * mints a key (`group:1`, `group:2`, ...) and keeps it while the group's
 * members mostly stay the same: the key is what the list draws the head
 * under, so the current entry and the rows' motion follow a relabelled group.
 *
 * What the user chose for a group (open, closed, show more) hangs on its
 * members, not on its key, so it outlives a group that splits, merges or is
 * gone for a while (see `FoldChoice`).
 */
import type { InboxGroupMember } from "@hercule/contract";

/** The key of a group. A thing's ref has two colons, so a group key never equals a ref. */
export type GroupKey = `group:${number}`;

/** The key of the "Show N more" line of a group. */
export type MoreKey = `${GroupKey}:more`;

/** Returns true when `key` is the key of a group's head. */
export const isGroupKey = (key: string): key is GroupKey => /^group:\d+$/.test(key);

/** Returns the key of the "Show N more" line of the group `groupKey`. */
export const buildMoreKey = (groupKey: GroupKey): MoreKey => `${groupKey}:more`;

/** Returns the key of the group whose "Show N more" line has the key `key`, or `null` when `key` is not such a key. */
export const parseMoreKey = (key: string): GroupKey | null => {
  const groupKey = key.endsWith(":more") ? key.slice(0, -":more".length) : key;
  return key !== groupKey && isGroupKey(groupKey) ? groupKey : null;
};

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

/**
 * What the user chose for a group, written to every member the group had when
 * the choice was made. A member with no choice leaves the group to the
 * display's default (see `isGroupOpen`).
 */
export interface FoldChoice {
  /** True when the user opened the group, false when they closed it. */
  readonly isOpen: boolean;
  /** True when the user asked to see every member ("Show N more"). */
  readonly isExpanded: boolean;
  /** Rises with each choice the user makes: the latest choice among a group's members wins. */
  readonly seq: number;
}

/**
 * Returns the choice that holds for `group`: the latest of its members'
 * choices, or `undefined` when none of them has one.
 *
 * Because the latest choice wins, a group made of two that merged shows the
 * fold the user chose last for either part, and both parts of a group that
 * split keep the fold the whole group had.
 */
export function findFoldChoice(
  group: HeldGroup,
  folds: ReadonlyMap<string, FoldChoice>,
): FoldChoice | undefined {
  let latest: FoldChoice | undefined;
  for (const member of group.members) {
    const choice = folds.get(member.ref);
    if (choice !== undefined && (latest === undefined || choice.seq > latest.seq)) latest = choice;
  }
  return latest;
}

/** Returns `folds` with `choice` written to every member of `group`. */
export function writeFoldChoice(
  folds: ReadonlyMap<string, FoldChoice>,
  group: HeldGroup,
  choice: FoldChoice,
): ReadonlyMap<string, FoldChoice> {
  const next = new Map(folds);
  for (const member of group.members) next.set(member.ref, choice);
  return next;
}

/** A group of this many held members or fewer shows them all when open. */
const SHOW_ALL_UP_TO = 7;
/** A larger group shows this many members until the user asks for more. */
const COLLAPSED_SHOWN = 5;

/**
 * A group as the list resolves it once per change: its operative members, its
 * held rows and how it draws. Moves, counts, ticks and words all read this, so
 * none of them can disagree about who is in the group.
 *
 * Two pairs of numbers stay apart on purpose:
 * - `members` against `rows`: the members a move acts on (held or not) against
 *   the members the visit holds a row for (hydrated).
 * - `size` above `members.length` means the reply was cut by the controller's
 *   bound on members per group (a group too large to move whole). Members that
 *   wait behind "N new" are not in `members` and not counted in `size`.
 */
export interface InboxGroupView<Row> {
  readonly key: GroupKey;
  readonly labelRef: string;
  readonly label: string;
  /**
   * The operative members: every member the group names, held or not, less
   * the members a dismissal on its way hid and the members that wait behind
   * "N new". The members that answer the query come first.
   */
  readonly members: readonly InboxGroupMember[];
  /** How many members the group has, less the ones left out of `members`. */
  readonly size: number;
  /** The held members, in member order. At least one. */
  readonly rows: readonly Row[];
  /** How many members the visit holds no row for: `size` less the held members. They are read when the group is shown open. */
  readonly unloadedCount: number;
  readonly isOpen: boolean;
  /**
   * The row whose time, ask and marks draw the head: the first held member
   * that answers the query, else the first held member.
   */
  readonly placedBy: Row;
  /** The refs of the held members that answer the query (`matches`): what X on the head selects. */
  readonly matchRefs: readonly string[];
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
      /** The member's place in its group, from 1, in member order: for `aria-posinset`. */
      readonly position: number;
      /** How many members the group has, held or not: for `aria-setsize`. */
      readonly of: number;
      /** True when the member answers the list's query; the others are drawn quieter. */
      readonly matches: boolean;
      /** True for the last line of the group, which ends the line that joins its members. */
      readonly isLast: boolean;
    }
  | {
      readonly kind: "more";
      readonly key: MoreKey;
      readonly groupKey: GroupKey;
      /** How many held members the line hides. */
      readonly hiddenCount: number;
      /** How many members the group has that the visit holds no row for yet. */
      readonly unloadedCount: number;
    };

interface Placed<Row> {
  readonly group: HeldGroup;
  /** The held members, in member order. At least one. */
  readonly held: readonly Row[];
}

/**
 * Works out which held rows form a group. A group is drawn as a group when it
 * holds at least one member (a group has two members or more by construction),
 * so a group the page cut still has its head. A ref in two groups belongs to the first.
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
    if (held.length < 1) continue;
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
 * Returns whether the list shows the members of `group`: when the user opened
 * it, else (with no choice) in a search when a member other than its label
 * answers the query.
 */
export const isGroupOpen = (
  group: HeldGroup,
  fold: FoldChoice | undefined,
  isSearch: boolean,
): boolean =>
  fold?.isOpen ??
  (isSearch && group.members.some((member) => member.matches && member.ref !== group.labelRef));

/**
 * Builds the entries the list draws, in order. A group with a held member
 * draws a head and, when open, its members; the others are things.
 *
 * - A group is open when the latest choice of its members says so (see
 *   `findFoldChoice`). With no choice, it is open in a search when a member
 *   other than its label answers the query, so a hit inside a group is not
 *   hidden behind its head.
 * - An open group of more than 7 held members shows its first 5 (the members
 *   that answer the query come first) and a "more" line, until expanded.
 */
export function buildEntries<Row extends { readonly ref: string }>(input: {
  readonly rows: readonly Row[];
  readonly groups: readonly HeldGroup[];
  /** The choices the user made, by member ref. */
  readonly folds: ReadonlyMap<string, FoldChoice>;
  readonly isSearch: boolean;
  readonly selection: ReadonlySet<string>;
  /** Refs the list does not show yet or any more: hidden by a dismissal on its way, or waiting behind "N new". No group counts them. */
  readonly notOnList: ReadonlySet<string>;
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
    pushGroup(entries, placed, findFoldChoice(placed.group, input.folds), input);
  }
  return entries;
}

function pushGroup<Row extends { readonly ref: string }>(
  entries: InboxEntry<Row>[],
  { group, held }: Placed<Row>,
  fold: FoldChoice | undefined,
  input: {
    readonly isSearch: boolean;
    readonly selection: ReadonlySet<string>;
    readonly notOnList: ReadonlySet<string>;
  },
): void {
  const members = group.members.some((member) => input.notOnList.has(member.ref))
    ? group.members.filter((member) => !input.notOnList.has(member.ref))
    : group.members;
  const size = group.size - (group.members.length - members.length);
  const matches = new Map(members.map((member) => [member.ref, member.matches]));
  const matchingRows = held.filter((row) => matches.get(row.ref) === true);
  const isOpen = isGroupOpen(group, fold, input.isSearch);
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
      members,
      size,
      rows: held,
      unloadedCount: size - held.length,
      isOpen,
      placedBy: matchingRows[0] ?? held[0]!,
      matchRefs: matchingRows.map((row) => row.ref),
      tick: isEveryMatchSelected ? "all" : selected.length > 0 ? "some" : "none",
    },
  });
  if (!isOpen) return;
  const shown =
    held.length <= SHOW_ALL_UP_TO || fold?.isExpanded === true
      ? held
      : held.slice(0, COLLAPSED_SHOWN);
  const hiddenCount = held.length - shown.length;
  const placeOf = new Map(members.map((member, index) => [member.ref, index + 1]));
  shown.forEach((row, index) => {
    entries.push({
      kind: "member",
      key: row.ref,
      row,
      groupKey: group.key,
      position: placeOf.get(row.ref) ?? index + 1,
      of: size,
      matches: matches.get(row.ref) === true,
      isLast: hiddenCount === 0 && index === shown.length - 1,
    });
  });
  if (hiddenCount > 0) {
    entries.push({
      kind: "more",
      key: buildMoreKey(group.key),
      groupKey: group.key,
      hiddenCount,
      unloadedCount: size - held.length,
    });
  }
}

/**
 * Returns `next`, with each entry that equals the entry of the same key in
 * `previous` replaced by that previous entry, so a line that did not change
 * keeps its object and is not drawn again. Returns `previous` itself when every
 * entry was kept and none was added.
 *
 * Entries are matched by key, not by place: when a row comes or goes, every
 * entry after it moves one place, and a match by place would compare different
 * rows. Rows are compared as objects, because the visit already keeps the same
 * row object while a row is unchanged.
 */
export function keepUnchangedEntries<Row>(
  previous: readonly InboxEntry<Row>[],
  next: readonly InboxEntry<Row>[],
): readonly InboxEntry<Row>[] {
  const previousByKey = new Map(previous.map((entry) => [entry.key, entry]));
  const kept = next.map((entry) => {
    const old = previousByKey.get(entry.key);
    return old !== undefined && isSameEntry(old, entry) ? old : entry;
  });
  const isAllKept =
    kept.length === previous.length && kept.every((entry, index) => entry === previous[index]);
  return isAllKept ? previous : kept;
}

/** Checks that two entries have the same fields. A head's group is compared field by field, and its arrays item by item. */
function isSameEntry<Row>(a: InboxEntry<Row>, b: InboxEntry<Row>): boolean {
  if (a.kind === "head" && b.kind === "head") {
    return a.key === b.key && haveSameFields(a.group, b.group, isSameItems);
  }
  return haveSameFields(a, b, Object.is);
}

/** Checks that `a` and `b` have the same keys and that `isSame` holds for the value of each. */
function haveSameFields(
  a: object,
  b: object,
  isSame: (left: unknown, right: unknown) => boolean,
): boolean {
  const keys = Object.keys(b);
  return (
    keys.length === Object.keys(a).length &&
    keys.every((key) => isSame(a[key as keyof typeof a], b[key as keyof typeof b]))
  );
}

/** Checks that two values are the same, or are arrays of the same items in the same order. */
const isSameItems = (a: unknown, b: unknown): boolean =>
  a === b ||
  (Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((item, index) => item === b[index]));

/**
 * Returns the refs a selection acts on for `entry`: a head's held members that
 * answer the query, a thing's or a member's own ref, and nothing for a "more" line.
 */
export function listSelectionRefs(entry: InboxEntry<{ readonly ref: string }>): readonly string[] {
  switch (entry.kind) {
    case "head":
      return entry.group.matchRefs;
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
export function listRefsOfEntries(
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
 * Returns the entry that now shows what the entry `key` showed, after the
 * entries changed to `newEntries`, or `null` when no entry does:
 * 1. `key` is still an entry: keep it.
 * 2. `key` is a thing a fold now hides, or a member a read pulled into a
 *    closed group: the head that shows it.
 * 3. `key` is a head or a "more" line: the head when it is still an entry,
 *    else the entry that now shows the first of the group's old members that
 *    is still shown (a member, or the head of the group it went to).
 */
export function findShowingKey(
  newEntries: readonly InboxEntry<{ readonly ref: string }>[],
  key: string,
  oldGroups: readonly HeldGroup[],
): string | null {
  if (newEntries.some((entry) => entry.key === key)) return key;
  const shown = findEntryKey(newEntries, key);
  if (shown !== null) return shown;
  const groupKey = parseMoreKey(key) ?? key;
  if (!isGroupKey(groupKey)) return null;
  if (newEntries.some((entry) => entry.key === groupKey)) return groupKey;
  const members = oldGroups.find((group) => group.key === groupKey)?.members ?? [];
  for (const member of members) {
    const showing = findEntryKey(newEntries, member.ref);
    if (showing !== null) return showing;
  }
  return null;
}

/**
 * Returns the entry key to keep as current after the entries changed from
 * `oldKeys` to `newEntries`, or `null` when nothing is left: the entry that
 * shows what `key` showed (see `findShowingKey`), else the entry after it in
 * the old order, else the one before, else the first.
 */
export function settleKey(
  oldKeys: readonly string[],
  newEntries: readonly InboxEntry<{ readonly ref: string }>[],
  key: string,
  oldGroups: readonly HeldGroup[],
): string | null {
  const showing = findShowingKey(newEntries, key, oldGroups);
  if (showing !== null) return showing;
  const newKeys = new Set(newEntries.map((entry) => entry.key));
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
 * keeps its key while its members change.
 *
 * - Overlap is counted on member refs. The incoming group and held group with
 *   the most refs in common are paired first, then the next most, each group in
 *   one pair at most. A tie goes to the first held group, then the first
 *   incoming one. A paired incoming group takes the held group's key; any other
 *   gets a fresh key.
 * - A held group that no incoming group took stays, less the members the read
 *   `covered` (they are in another group or alone now). It is dropped when fewer
 *   than two members are left, so a group the read did not mention is kept.
 * - An incoming group of fewer than two members is not a group.
 *
 * The key decides only which head the list keeps drawing. Whether a group
 * that merged or split is open does not follow the key: it follows the
 * choices of its members (see `findFoldChoice`).
 *
 * Returns the groups in the order: incoming first, then the ones kept.
 */
export function reconcileGroups(input: {
  readonly previous: readonly HeldGroup[];
  readonly incoming: readonly IncomingGroup[];
  readonly covered: ReadonlySet<string>;
  readonly nextNumber: number;
}): { readonly groups: HeldGroup[]; readonly nextNumber: number } {
  const { previous, covered } = input;
  const incoming = input.incoming.filter((group) => group.members.length >= 2);
  const previousRefs = previous.map((group) => new Set(group.members.map((m) => m.ref)));
  const pairs = incoming.flatMap((group, i) =>
    previousRefs.flatMap((refs, j) => {
      const overlap = group.members.filter((member) => refs.has(member.ref)).length;
      return overlap > 0 ? [{ incoming: i, previous: j, overlap }] : [];
    }),
  );
  pairs.sort((a, b) => b.overlap - a.overlap || a.previous - b.previous || a.incoming - b.incoming);
  const takenBy = new Map<number, number>();
  const taken = new Set<number>();
  for (const pair of pairs) {
    if (takenBy.has(pair.incoming) || taken.has(pair.previous)) continue;
    takenBy.set(pair.incoming, pair.previous);
    taken.add(pair.previous);
  }

  let nextNumber = input.nextNumber;
  const groups: HeldGroup[] = incoming.map((group, i) => {
    const claimed = takenBy.get(i);
    if (claimed !== undefined) return { ...group, key: previous[claimed]!.key };
    const key: GroupKey = `group:${nextNumber}`;
    nextNumber += 1;
    return { ...group, key };
  });
  previous.forEach((group, j) => {
    if (!taken.has(j)) groups.push(...removeMembers([group], covered));
  });
  return { groups, nextNumber };
}
