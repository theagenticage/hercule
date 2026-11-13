/**
 * What a thing (an External Entity) tells an agent about itself in a prompt's
 * context block: its stored record and declared field values as the plain
 * text the block holds. The block itself is written by `formatPromptContext`
 * in `@hercule/contract`; this module only turns stored rows into its input.
 * It is pure: reading the rows is the service's job.
 */
import type {
  EntityFieldValue,
  PromptContextField,
  PromptContextOrigin,
  PromptContextThing,
} from "@hercule/contract";
import { buildLockedLabel, isRestrictedPlace } from "./entity-records";
import type { TaskableEntity } from "./repository";

/**
 * Where a prompt's things came from, as decided before the label text is
 * known. A group names its label thing by ref. The text of the label is read
 * from that thing's current record when the block is written, so access that
 * changes between the two reads is never missed.
 */
export type PromptContextOriginSource =
  | { readonly kind: "group"; readonly labelRef: string }
  | { readonly kind: "selection" }
  | { readonly kind: "one" };

/**
 * Builds the origin of the block from `source` and the current `records` of
 * the prompt's things. The label of a group is the title of its label thing,
 * or the locked label (`A pull request you cannot open`) when that thing is a
 * restricted place, so its stored title never reaches the prompt. The label
 * thing is one of `records`: a group is exactly its members.
 */
export const buildPromptContextOrigin = (
  source: PromptContextOriginSource,
  records: ReadonlyArray<TaskableEntity>,
): PromptContextOrigin => {
  if (source.kind !== "group") return source;
  const labelRecord = records.find((record) => record.ref === source.labelRef)!;
  return {
    kind: "group",
    label: isRestrictedPlace(labelRecord) ? buildLockedLabel(labelRecord.noun) : labelRecord.title,
  };
};

/**
 * Returns a field value as the text a prompt shows next to the field's label.
 * Numbers are written plainly, money as `<amount> <currency>`, an age as the
 * ISO time it counts from (an agent cannot use a relative "3d" that goes stale
 * in the transcript), and a flag as `yes` or `no`.
 */
const describeFieldValue = (field: EntityFieldValue): string => {
  switch (field.type) {
    case "text":
    case "person":
    case "enum":
      return field.text;
    case "number":
      return String(field.number);
    case "money":
      return `${String(field.amount)} ${field.currency}`;
    case "age":
      return field.since;
    case "bool":
      return field.value ? "yes" : "no";
  }
};

const describeField = (field: EntityFieldValue): PromptContextField => ({
  key: field.key,
  type: field.type,
  label: field.label,
  value: describeFieldValue(field),
  // A text field that names another record also carries that record's ref,
  // because its text is only the title and two records can share a title.
  ...(field.type === "text" && field.ref !== undefined ? { ref: field.ref } : {}),
});

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
    fields: fields.map(describeField),
  };
};
