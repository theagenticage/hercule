/**
 * Where Intake's selection goes when a move takes rows off the list.
 */

/**
 * Returns the row to select once the rows `movedIds` leave a list whose rows
 * are `listedIds`, in list order, while `selectedId` is selected:
 *
 * - the selected row itself, when it stays;
 * - else the first row after it that stays;
 * - else the last row before it that stays;
 * - `null` when no row stays, or when nothing was selected.
 *
 * The selection then stays where the user was reading, as it does in a mail
 * client after an archive.
 */
export const pickSelectionAfterMove = (
  listedIds: ReadonlyArray<string>,
  selectedId: string | null,
  movedIds: ReadonlyArray<string>,
): string | null => {
  if (selectedId === null) return null;
  const moved = new Set(movedIds);
  if (!moved.has(selectedId)) return selectedId;
  const at = listedIds.indexOf(selectedId);
  if (at < 0) return null;
  const after = listedIds.slice(at + 1).find((id) => !moved.has(id));
  if (after !== undefined) return after;
  return listedIds.slice(0, at).findLast((id) => !moved.has(id)) ?? null;
};
