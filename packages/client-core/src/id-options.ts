/**
 * The options of a select that picks a record by its id, such as a provider
 * instance, a permission profile or a Connection.
 *
 * A select whose value matches none of its options shows its first option
 * instead, so the screen would claim a choice that is not stored. The stored
 * id is therefore always one of the options. When the list of records lacks
 * it, it is added at the end with its id tail and a note:
 *
 * - "(not found)" when the list is loaded, because the record was deleted.
 * - "(list not loaded)" when the list is still loading or failed to load,
 *   because nothing then says that the record is gone.
 *
 * The model select of Settings > Threads marks a model it no longer offers
 * the same way.
 */
import { toIdTail } from "./id-tail";

/** One option of a select that picks a record by its id. */
export interface IdOption {
  readonly id: string;
  readonly label: string;
}

/**
 * Returns the select's options: one per choice, in the order given, plus an
 * option for `storedId` when no choice has that id.
 *
 * - `choices` is null while the list of records is not loaded.
 * - A null `storedId` adds nothing.
 */
export const buildIdOptions = (
  choices: readonly IdOption[] | null,
  storedId: string | null,
): readonly IdOption[] => {
  const loaded = choices ?? [];
  if (storedId === null || loaded.some((choice) => choice.id === storedId)) return loaded;
  const note = choices === null ? "list not loaded" : "not found";
  return [...loaded, { id: storedId, label: `${toIdTail(storedId)} (${note})` }];
};
