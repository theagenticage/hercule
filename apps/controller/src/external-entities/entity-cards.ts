/**
 * What a small card shows of a thing (an External Entity): its stored record
 * and card face as an `EntityCard`. It is pure: reading the rows is the
 * service's job.
 */
import type { CardFace, EntityCard } from "@hercule/contract";
import { findActiveKind, isRestrictedPlace, type ActiveEntityKind } from "./entity-records";
import type { TaskableEntity } from "./repository";

/**
 * Builds the card of one stored record, or returns undefined when the record
 * has no noun stored and no active kind owns its ref, because a card must say
 * what kind of thing it is. A client draws what it knows for such a thing.
 *
 * - A restricted place (`isRestrictedPlace`) gives only its id, ref, kind and
 *   noun, with no face and no `card`: its stored title, status and fields are
 *   what the user could once read.
 * - Any other record gives what its rows hold, including a full record that
 *   lost access (its last known facts). A partial record may have no
 *   identifier, title or `card` yet, and then the card leaves them out.
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
  if (isRestrictedPlace(record)) return { ...base, face: null, restricted: true };
  return {
    ...base,
    ...(record.card === undefined ? {} : { card: record.card }),
    ...(record.identifier === "" ? {} : { identifier: record.identifier }),
    ...(record.title === "" ? {} : { title: record.title }),
    ...(record.status === undefined ? {} : { status: record.status }),
    face,
    restricted: false,
  };
};
