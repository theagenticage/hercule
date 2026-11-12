/**
 * The values of the fields a kind declares and the card face drawn from them.
 *
 * Nothing here reads the database. The repository reads the stored field rows,
 * each with the title of the record it points at (`readTitledFieldRows`), and
 * this module decides what they mean.
 */
import type { CardFace, EntityFieldValue } from "@hercule/contract";
import { CARD_FACE_SLOTS, type QualifiedEntityFieldDeclaration } from "@hercule/plugin-host";
import type { ActiveEntityKind } from "./entity-records";
import { isRepresentableAge, type TitledFieldRow } from "./entity-fields";

/** Checks that a field holds a ref: its facet lists the records of a context kind. */
const holdsRef = (declaration: QualifiedEntityFieldDeclaration): boolean =>
  declaration.type === "text" && declaration.facet?.values !== undefined;

/** Indexes the rows by their key. */
const indexByKey = (rows: ReadonlyArray<TitledFieldRow>): Map<string, TitledFieldRow> =>
  new Map(rows.map((row) => [row.key, row]));

/**
 * Builds the value of one declared field from its stored row. Returns
 * undefined when there is no row, when the row's encoding does not fit the
 * field's current declaration (a stale row that the next observation
 * rewrites), when an enum value is no longer declared, or when a ref has no
 * readable record (its title is null), or when an age is outside the years
 * 0000 to 9999. It never fails and never reinterprets a row.
 */
const buildFieldValue = (
  declaration: QualifiedEntityFieldDeclaration,
  row: TitledFieldRow | undefined,
): EntityFieldValue | undefined => {
  if (row === undefined) return undefined;
  const identity = { key: declaration.key, label: declaration.label };
  const { text_value: text, number_value: number } = row;
  switch (declaration.type) {
    case "text":
    case "person":
    case "enum": {
      if (text === null || number !== null) return undefined;
      if (declaration.type === "enum") {
        const declared = declaration.values.find((entry) => entry.value === text);
        if (declared === undefined) return undefined;
        return { ...identity, type: "enum", value: text, text: declared.label ?? text };
      }
      if (declaration.type === "text" && holdsRef(declaration)) {
        const title = row.title;
        if (title === null) return undefined;
        return { ...identity, type: "text", text: title, ref: text };
      }
      return { ...identity, type: declaration.type, text };
    }
    case "number":
    case "money":
    case "age":
    case "bool": {
      if (number === null || text !== null || !Number.isFinite(number)) return undefined;
      switch (declaration.type) {
        case "number":
          return { ...identity, type: "number", number };
        case "money":
          return { ...identity, type: "money", amount: number, currency: declaration.currency };
        case "age": {
          return isRepresentableAge(number)
            ? { ...identity, type: "age", since: new Date(number).toISOString() }
            : undefined;
        }
        case "bool":
          return number === 0 || number === 1
            ? { ...identity, type: "bool", value: number === 1 }
            : undefined;
      }
    }
  }
};

/**
 * Draws the field values of a thing and its card face from the stored rows of
 * its fields. Returns both as `{ fields, face }`. A ref-valued field takes its
 * text from the title its row carries.
 *
 * - Only declared keys come back, in declaration order. A row of an
 *   undeclared key is ignored.
 * - A kind that is not active (its plugin is stopped, or the kind is gone)
 *   gives no fields and no face, so the client draws the generic card.
 * - A kind that declares no face gives a null face.
 * - A slot of the face whose field has no value is left out.
 */
export const drawFieldsAndCardFace = (
  kind: ActiveEntityKind | undefined,
  rows: ReadonlyArray<TitledFieldRow>,
): { readonly fields: EntityFieldValue[]; readonly face: CardFace | null } => {
  if (kind === undefined) return { fields: [], face: null };
  const byKey = indexByKey(rows);
  const fields = (kind.fields ?? []).flatMap((declaration) => {
    const value = buildFieldValue(declaration, byKey.get(declaration.key));
    return value === undefined ? [] : [value];
  });
  if (kind.face === undefined) return { fields, face: null };
  const face: { -readonly [Slot in keyof CardFace]: CardFace[Slot] } = {};
  for (const slot of CARD_FACE_SLOTS) {
    const key = kind.face[slot];
    const value = key === undefined ? undefined : fields.find((field) => field.key === key);
    if (value !== undefined) face[slot] = value;
  }
  return { fields, face };
};
