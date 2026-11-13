/**
 * What a small card shows of a thing (an External Entity): its stored record
 * and card face as an `EntityCard`. It is pure: reading the rows is the
 * service's job.
 */
import type { CardFace, EntityCard } from "@hercule/contract";
import { findActiveKind, type ActiveEntityKind } from "./entity-records";
import type { TaskableEntity } from "./repository";

/**
 * Builds the card of one stored record, or returns undefined when the record
 * has no noun stored and no active kind owns its ref, because a card must say
 * what kind of thing it is. A client draws what it knows for such a thing.
 *
 * - A record that no Connection can read now, whether it is full or partial,
 *   gives only its id, ref, kind and noun, with no face: its stored title,
 *   status and fields are what the user could once read. This is the rule
 *   `buildPromptContextThing` uses.
 * - Any other record gives what its rows hold. A partial record may have no
 *   identifier or title yet, and then the card leaves them out.
 *
 * `face` is the card face read for the record, null when its kind declares
 * none. A partial record may have no kind stored; the card then takes the
 * kind and noun of the active kind that owns its ref.
 */
export const buildEntityCard = (
  record: TaskableEntity,
  face: CardFace | null,
  kinds: ReadonlyArray<ActiveEntityKind>,
): EntityCard | undefined => {
  const owner = findActiveKind(kinds, record.ref);
  const noun = record.noun === "" ? owner?.noun : record.noun;
  if (noun === undefined) return undefined;
  const base = {
    id: record.id,
    ref: record.ref,
    kind: record.kind === "" ? (owner?.kind ?? "") : record.kind,
    noun,
  };
  if (record.access !== "ok") return { ...base, face: null, restricted: true };
  return {
    ...base,
    ...(record.identifier === "" ? {} : { identifier: record.identifier }),
    ...(record.title === "" ? {} : { title: record.title }),
    ...(record.status === undefined ? {} : { status: record.status }),
    face,
    restricted: false,
  };
};
