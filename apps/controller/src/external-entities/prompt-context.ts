/**
 * What a thing (an External Entity) tells an agent about itself in a prompt's
 * context block: its stored record and declared field values. The block's text
 * is written by `appendPromptContext` in `@hercule/contract`; this module only
 * turns stored rows into its input. It is pure: reading the rows is the
 * service's job.
 */
import type { EntityFieldValue, PromptContextOrigin, PromptContextThing } from "@hercule/contract";
import { buildLockedLabel, isRestrictedPlace } from "./entity-records";
import type { TaskableEntity } from "./repository";

/**
 * Builds the origin of the block from the current `records` of the prompt's
 * things and `labelRef`, the ref of the label thing of the Inbox group the
 * things make up (`undefined` when they are not a group).
 *
 * - One record: `one`.
 * - 2 or more records and no `labelRef`: `selection`.
 * - 2 or more records and a `labelRef`: `group`, labelled with the title of
 *   the label thing, or with the locked label (`A pull request you cannot
 *   open`) when that thing is a restricted place, so its stored title never
 *   reaches the prompt. The label thing is one of `records`: a group is
 *   exactly its members.
 */
export const buildPromptContextOrigin = (
  labelRef: string | undefined,
  records: ReadonlyArray<TaskableEntity>,
): PromptContextOrigin => {
  if (records.length === 1) return { kind: "one" };
  if (labelRef === undefined) return { kind: "selection" };
  const labelRecord = records.find((record) => record.ref === labelRef)!;
  return {
    kind: "group",
    label: isRestrictedPlace(labelRecord) ? buildLockedLabel(labelRecord.noun) : labelRecord.title,
  };
};

/**
 * Returns the prompt context entry of one stored record, given the declared
 * field values read for it (empty when none).
 *
 * - A restricted place (`isRestrictedPlace`) gives only its ref and id,
 *   because its stored title, status and fields are what the user could once
 *   read. The ref already names the kind of thing.
 * - Any other record gives what its rows hold, including a full record that
 *   lost access (its last known facts): a partial record's title may be empty
 *   and its fields are those stored.
 */
export const buildPromptContextThing = (
  record: TaskableEntity,
  fields: ReadonlyArray<EntityFieldValue>,
): PromptContextThing => {
  if (isRestrictedPlace(record)) return { entityId: record.id, ref: record.ref, fields: [] };
  return {
    entityId: record.id,
    ref: record.ref,
    ...(record.title === "" ? {} : { title: record.title }),
    ...(record.status === undefined ? {} : { status: record.status.label }),
    fields,
  };
};
