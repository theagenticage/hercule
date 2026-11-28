/**
 * Checks the External Entity kinds an event source declares, and returns them
 * qualified with the plugin's id, ready for the core to copy their captions onto
 * the entities it stores.
 *
 * A declaration is data, so the host checks all of it when the plugin loads. A
 * mistake then refuses the source while the plugin's author reads the error,
 * instead of failing on every poll later, where only the logs would show it.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  CARD_FACE_SLOTS,
  CORE_INBOX_FIELD_KEYS,
  CARD_FACE_SLOT_FIELD_TYPES,
  FACET_FIELD_TYPES,
  type EntityFactDeclaration,
  type EntityFieldType,
  EntityFieldDeclaration,
  EntityKindDeclaration,
  PluginError,
  type EntityStatusDeclaration,
  QualifiedEntityKindDeclaration,
  type PluginManifest,
} from "@hercule/plugin-host";
import { convertExactColorToHex, describeExactColor } from "./colors";
import { describeFieldIssues } from "./errors";

/** A kind that another source of the plugin, or another plugin, has already registered. */
export interface TakenEntityKinds {
  /** The qualified words the plugin's other sources declared. */
  readonly words: ReadonlySet<string>;
  /** The ref prefixes of every kind registered so far, in any plugin, with the kind that owns each. */
  readonly refPrefixes: ReadonlyArray<{ readonly kind: string; readonly refPrefix: string }>;
}

const decodeDeclaration = Schema.decodeUnknownEffect(EntityKindDeclaration, { errors: "all" });

/**
 * Returns the status table of a kind with every colour as a hex code (see
 * `convertExactColorToHex`), or the key and colour of the first status whose
 * colour is no CSS colour.
 */
const convertStatusColors = (
  table: EntityKindDeclaration["status"],
):
  | { readonly status: EntityKindDeclaration["status"] }
  | { readonly key: string; readonly color: string } => {
  if (table === null) return { status: table };
  const converted: Record<string, EntityStatusDeclaration> = {};
  for (const [key, declaration] of Object.entries(table)) {
    if (declaration.color === undefined) {
      converted[key] = declaration;
      continue;
    }
    const color = convertExactColorToHex(declaration.color);
    if (color === undefined) return { key, color: describeExactColor(declaration.color) };
    converted[key] = { ...declaration, color };
  }
  return { status: converted };
};

const areFieldsEqual = Schema.toEquivalence(EntityFieldDeclaration);

/**
 * The types of field each form of fact can read. The renderer turns the value
 * into text and reads that text, so a form takes a type only when its text can
 * be right.
 *
 * - `delta` reads text like `+120 -30`: only `text` holds that. A number, an
 *   amount, a timestamp or a boolean never does, and a person or an enum value
 *   is a name or a label.
 * - `count` and `bars` read digits: a `number` or `money` amount, or `text`
 *   that holds digits. An enum value or a person is a label, so the plugin
 *   keeps the number in a `number` field.
 * - `date` reads a timestamp: an `age` or `text`.
 * - `word` and `money` show the text as it is, so any type reads.
 */
const FACT_FORM_FIELD_TYPES: Readonly<
  Record<EntityFactDeclaration["form"], ReadonlyArray<EntityFieldType>>
> = {
  delta: ["text"],
  count: ["number", "money", "text"],
  bars: ["number", "money", "text"],
  date: ["age", "text"],
  word: ["text", "person", "enum", "number", "money", "age", "bool"],
  money: ["text", "person", "enum", "number", "money", "age", "bool"],
};

/** The first declaration of a field key in a source, and the kind that made it. */
interface FirstDeclaration {
  readonly field: EntityFieldDeclaration;
  readonly kind: string;
}

/**
 * Checks the fields and the card face of one kind. Returns the reason the
 * declaration is wrong, written to say what to do, or undefined when it is
 * right. `ownKinds` are the words of the source's kinds with their pace, and
 * `firstDeclarationByKey` holds the first declaration of every field key the
 * source's earlier kinds declared. It does not change it.
 */
const findFieldProblem = (
  declaration: EntityKindDeclaration,
  ownKinds: ReadonlyMap<string, EntityKindDeclaration["pace"]>,
  firstDeclarationByKey: ReadonlyMap<string, FirstDeclaration>,
): string | undefined => {
  const fields = declaration.fields ?? [];
  const types = new Map<string, EntityFieldType>();
  for (const field of fields) {
    if (types.has(field.key)) {
      return `its field "${field.key}" is declared twice. Give each field of a kind its own key.`;
    }
    if (CORE_INBOX_FIELD_KEYS.some((key) => key === field.key)) {
      return `its field "${field.key}" has the key of one of the Inbox's own query fields (${CORE_INBOX_FIELD_KEYS.join(", ")}). Every source answers those, so a clause with that key could not mean your field. Give the field another key, such as "${field.key}-${field.type}".`;
    }
    types.set(field.key, field.type);
    if (field.facet !== undefined && !FACET_FIELD_TYPES.includes(field.type)) {
      return `its field "${field.key}" has a facet, but its type is "${field.type}". A facet lists values a person can name, so use the type text, person or enum, or remove the facet.`;
    }
    const valuesKind = field.facet?.values;
    if (valuesKind !== undefined && ownKinds.get(valuesKind) !== "context") {
      return `the facet values of its field "${field.key}" name "${valuesKind}", which is not a context kind (pace "context") of this source. Write the word of one of the source's own context kinds, or leave values out.`;
    }
    if (field.type === "enum") {
      const seen = new Set<string>();
      for (const { value } of field.values) {
        if (seen.has(value)) {
          return `its enum field "${field.key}" lists the value "${value}" twice. List each value once.`;
        }
        seen.add(value);
      }
    }
    if (valuesKind !== undefined && field.type !== "text") {
      return `its field "${field.key}" has facet values from the context kind "${valuesKind}", but its type is "${field.type}". The field holds the ref of a record of that kind, so make its type text.`;
    }
    const first = firstDeclarationByKey.get(field.key);
    if (first !== undefined && !areFieldsEqual(first.field, field)) {
      return `its field "${field.key}" is declared differently from the same key in ${first.kind} (type, label, values, currency or facet differ). One key has one meaning in a source, so make the two declarations identical or use another key.`;
    }
  }
  for (const fact of declaration.facts) {
    const type = types.get(fact.field);
    if (type !== undefined && !FACT_FORM_FIELD_TYPES[fact.form].includes(type)) {
      return `its ${fact.form} fact reads the field "${fact.field}", whose type is "${type}", which a ${fact.form} fact cannot read. Make the field one of type ${FACT_FORM_FIELD_TYPES[fact.form].join(", ")}, or report the value the fact needs in another field of one of those types and name that field.`;
    }
  }
  const face = declaration.face;
  if (face === undefined) return undefined;
  if (declaration.pace === "context") {
    return `it declares a face, but a context kind has no card. Remove the face.`;
  }
  for (const slot of CARD_FACE_SLOTS) {
    const key = face[slot];
    if (key === undefined) continue;
    const type = types.get(key);
    if (type === undefined) {
      return `its face ${slot} is "${key}", which is not a field the kind declares. Name the key of one of its fields.`;
    }
    if (!CARD_FACE_SLOT_FIELD_TYPES[slot].includes(type)) {
      return `its face ${slot} is the field "${key}", whose type is "${type}". The ${slot} of a face reads a field of type ${slot === "fact" ? "number or money" : "text, person or enum"}.`;
    }
  }
  return undefined;
};

const decodeQualified = Schema.decodeUnknownEffect(QualifiedEntityKindDeclaration, {
  errors: "all",
});

/**
 * Decodes the entity kinds of one event source, and returns them qualified.
 * A plugin writes its own words unqualified, `pull-request`, in `word`, `home`
 * and `section`. The host qualifies all three with the plugin's id, so
 * `pull-request` becomes `github/pull-request`. It qualifies the `facet.values`
 * of every field the same way.
 *
 * Fails with a `PluginError` naming the kind when:
 *
 * - the declaration does not match `EntityKindDeclaration`: for example a
 *   status shape or tone outside the fixed sets, a status `stage` that is not
 *   a Task stage, more than three facts, or an `identifier` template with no
 *   `{field}` placeholder or with a stray brace;
 * - another kind, of this source or of another source of the plugin, has the
 *   same word;
 * - its `refPrefix` and the `refPrefix` of another kind registered so far, in
 *   this plugin or another, are equal or one starts with the other. A ref could
 *   then belong to two kinds;
 * - its `home` or `section` is not the word of a kind of this same source;
 * - the colour of one of its statuses is a word that is no CSS colour name;
 * - it declares more than 16 fields, or one field key twice, or an `enum`
 *   field with a repeated value;
 * - a field has a `facet` and a type other than `text`, `person` or `enum`, or
 *   its `facet.values` is not the word of a context kind of this same source;
 * - a fact names a declared field whose type its form cannot read (see
 *   `FACT_FORM_FIELD_TYPES`), such as a `bars` fact on an `enum` field;
 * - its `face` is on a context kind, names a slot that is no declared field,
 *   puts a field of type other than `text`, `person` or `enum` in `place` or
 *   `context`, or one other than `number` or `money` in `fact`;
 * - a field whose `facet.values` names a context kind is not of type `text`,
 *   because it holds that kind's ref;
 * - another kind of this source declares the same field key with a declaration
 *   that is not identical (type, label, values, currency or facet).
 *
 * Every status colour of the kinds it returns is a hex code.
 */
export const decodeEntityKinds = (
  manifest: PluginManifest,
  sourceId: string,
  declarations: ReadonlyArray<EntityKindDeclaration>,
  taken: TakenEntityKinds,
): Effect.Effect<ReadonlyArray<QualifiedEntityKindDeclaration>, PluginError> =>
  Effect.gen(function* () {
    const qualify = (word: string): string => `${manifest.id}/${word}`;
    const decoded: Array<EntityKindDeclaration> = [];
    for (const declaration of declarations) {
      decoded.push(
        yield* Effect.mapError(
          decodeDeclaration(declaration),
          (error) =>
            new PluginError({
              message: `the entity kind ${qualify(declaration.word)} of the event source ${sourceId} is invalid: ${describeFieldIssues(error)}`,
            }),
        ),
      );
    }

    const ownWords = new Set(decoded.map(({ word }) => word));
    const ownKinds = new Map(decoded.map(({ word, pace }) => [word, pace]));
    const firstDeclarationByKey = new Map<string, FirstDeclaration>();
    const registered: Array<QualifiedEntityKindDeclaration> = [];
    const prefixes = [...taken.refPrefixes];
    for (const declaration of decoded) {
      const kind = qualify(declaration.word);
      const invalid = (reason: string) =>
        new PluginError({
          message: `the entity kind ${kind} of the event source ${sourceId} is invalid: ${reason}`,
        });
      if (taken.words.has(kind) || registered.some((other) => other.word === kind)) {
        return yield* Effect.fail(
          new PluginError({
            message: `the entity kind ${kind} is declared twice. Give each entity kind of the plugin its own word.`,
          }),
        );
      }
      const overlapping = prefixes.find(
        (other) =>
          other.refPrefix.startsWith(declaration.refPrefix) ||
          declaration.refPrefix.startsWith(other.refPrefix),
      );
      if (overlapping !== undefined) {
        return yield* Effect.fail(
          invalid(
            `its refPrefix "${declaration.refPrefix}" overlaps the refPrefix "${overlapping.refPrefix}" of ${overlapping.kind}, so a ref could belong to either. Give each kind a refPrefix that no other kind's starts with, such as "github:pr:".`,
          ),
        );
      }
      for (const field of ["home", "section"] as const) {
        const target = declaration[field];
        if (target !== undefined && !ownWords.has(target)) {
          return yield* Effect.fail(
            invalid(
              `its ${field} is "${target}", which is not a kind this source declares. Write the word of one of the source's own entity kinds.`,
            ),
          );
        }
      }
      const fieldProblem = findFieldProblem(declaration, ownKinds, firstDeclarationByKey);
      if (fieldProblem !== undefined) return yield* Effect.fail(invalid(fieldProblem));
      for (const field of declaration.fields ?? []) {
        if (!firstDeclarationByKey.has(field.key)) {
          firstDeclarationByKey.set(field.key, { field, kind: declaration.word });
        }
      }
      const statuses = convertStatusColors(declaration.status);
      if ("key" in statuses) {
        return yield* Effect.fail(
          invalid(
            `the colour ${statuses.color} of its status "${statuses.key}" is not a CSS colour. Write a hex code such as "#8250df" or a CSS colour name such as "purple".`,
          ),
        );
      }
      prefixes.push({ kind, refPrefix: declaration.refPrefix });
      registered.push(
        yield* Effect.mapError(
          decodeQualified({
            ...declaration,
            status: statuses.status,
            word: kind,
            ...(declaration.home === undefined ? {} : { home: qualify(declaration.home) }),
            ...(declaration.section === undefined ? {} : { section: qualify(declaration.section) }),
            ...(declaration.fields === undefined
              ? {}
              : {
                  fields: declaration.fields.map((field) =>
                    field.facet?.values === undefined
                      ? field
                      : {
                          ...field,
                          facet: { ...field.facet, values: qualify(field.facet.values) },
                        },
                  ),
                }),
          }),
          (error) => invalid(describeFieldIssues(error)),
        ),
      );
    }
    return registered;
  });
