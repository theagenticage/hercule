/**
 * Renders the slots of an External Entity: the identifier, person, owner,
 * status, facts and reason a card draws, worked out from the kind's
 * declaration and one observation. A plugin reports raw `fields` and keys, and
 * the core applies the declaration once, when the entity is observed. The
 * result is stored on the row, so a card draws from its row with no plugin
 * running and no kind in the catalog.
 */
import { Effect, Option, Schema } from "effect";
import {
  ENTITY_CONCERNS,
  EntityFact,
  EntityPerson,
  EntityReason,
  EntityStatus,
  MAX_ENTITY_FACTS,
  TaskStage,
  atMost,
  bounded,
  formatIssue,
  listDecodeIssues,
  truncateMessage,
} from "@hercule/contract";
import {
  PluginError,
  type EntityFactDeclaration,
  type EntityObservation,
  type QualifiedEntityKindDeclaration,
} from "@hercule/plugin-host";
import { fillSentence, listPlaceholders } from "./sentences";

/**
 * A status as it is stored: what a card draws, plus the Task stage the kind's
 * status table declares for it. The stage is internal. It is stored so a Task
 * can start at the right stage with no catalog lookup, and `parseStoredStatus`
 * strips it before a status reaches the public API.
 */
export const StoredEntityStatus = Schema.Struct({
  ...EntityStatus.fields,
  stage: Schema.optionalKey(TaskStage),
});

export type StoredEntityStatus = Schema.Schema.Type<typeof StoredEntityStatus>;

/** The slots of a kind that has cards: everything a card draws, apart from what changes per read. */
const WorkEntitySlots = Schema.Struct({
  noun: bounded(1, 40),
  card: Schema.Literals(["rich", "compact"]),
  pace: Schema.Literals(["fast", "slow"]),
  patience: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** The qualified kind of the places this kind usually lies under, copied from the declaration. */
  home: Schema.optionalKey(Schema.String),
  /** The qualified kind of the level shown on a row below its home. */
  section: Schema.optionalKey(Schema.String),
  identifier: bounded(1, 64),
  person: Schema.optionalKey(EntityPerson),
  /** The owner field's value as text. Absent when the kind has no owner or the thing has none. */
  owner: Schema.optionalKey(bounded(1, 120)),
  status: Schema.optionalKey(StoredEntityStatus),
  facts: atMost(EntityFact, MAX_ENTITY_FACTS),
  reason: Schema.optionalKey(EntityReason),
  /**
   * The sentence the kind declares for each concern it has a reason for, by
   * concern word. A card says one of these when the source names no reason
   * of its own.
   */
  concernReasons: Schema.optionalKey(Schema.Record(Schema.String, EntityReason)),
  /**
   * The kind's `reasons` table as declared, unfilled, by reason key. The
   * Inbox builds a signal's sentence and a timeline line from it long after
   * the plugin is gone, so it is copied here rather than read from the catalog.
   */
  reasonTemplates: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({ say: Schema.String, tone: EntityReason.fields.tone }),
    ),
  ),
});

/** The slots of a kind that is a place, such as a repository: no card, no clock, no facts. */
const ContextEntitySlots = Schema.Struct({
  noun: bounded(1, 40),
  pace: Schema.Literal("context"),
  /** The words for the kind when it can group things, such as "GitHub repository". */
  caption: Schema.optionalKey(bounded(1, 60)),
  home: Schema.optionalKey(Schema.String),
  section: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(EntityStatus),
});

/** What `renderEntitySlots` returns: `pace` tells a work record from a place. */
export const EntitySlots = Schema.Union([WorkEntitySlots, ContextEntitySlots]);

export type EntitySlots = Schema.Schema.Type<typeof EntitySlots>;

/** An observation that carries `fields`, which a partial one need not. */
export type FullEntityObservation = Exclude<EntityObservation, { readonly partial: true }>;

const decodeSlots = Schema.decodeUnknownEffect(EntitySlots, { errors: "all" });

/** Matches the text of a `delta` fact: `+120 -30`. */
const DELTA_TEXT = /^\+(\d+) -(\d+)$/;

/**
 * Renders the slots of one observation with its kind's declaration.
 *
 * - A kind with cards gets noun, card (`rich` when the declaration leaves it
 *   out), pace, patience, identifier, person, owner, status, facts and reason.
 *   It also gets `concernReasons`: each reason of the declaration that is named
 *   like a concern, filled in, unless a field it needs is missing. And it gets
 *   `reasonTemplates`: the declaration's whole `reasons` table, unfilled.
 * - A kind with cards or a place also gets the `home` and `section` its
 *   declaration names, as qualified kinds.
 * - A status keeps its `norm` flag, and a kind with cards also keeps the
 *   `stage` its status table declares (see `StoredEntityStatus`).
 * - A place (pace `context`) gets noun, caption, home, section and status only.
 * - A `delta` fact reads its field as text like `+120 -30`.
 * - A `count` fact reads a whole number and takes its unit from the declaration.
 * - A `date` fact reads a timestamp.
 * - A fact whose field is missing, null or empty is left out, because a thing
 *   may simply not have one. Person and owner are left out the same way.
 *
 * Fails with a `PluginError`, naming the kind, the ref and what was wrong,
 * when a template names a field the observation did not report, the status or
 * reason key is not in the declaration, a fact cannot be read in its form, or
 * a rendered value breaks a bound of the public API. The caller refuses the
 * whole inventory then, so nothing is stored.
 */
export const renderEntitySlots = (
  declaration: QualifiedEntityKindDeclaration,
  observation: FullEntityObservation,
): Effect.Effect<EntitySlots, PluginError> =>
  Effect.gen(function* () {
    const where = `${declaration.word} ${observation.ref}`;
    const refuse = (problem: string) =>
      Effect.fail(new PluginError({ message: truncateMessage(`${where}: ${problem}`) }));

    /** Returns the field as text, or undefined when it is missing, null or empty. */
    const readText = (name: string): string | undefined => {
      const value = observation.fields[name];
      return value === undefined || value === null || value === "" ? undefined : String(value);
    };

    /** Fills each `{name}` of a template from the fields, or from `extra` first. */
    const fillTemplate = (
      template: string,
      purpose: string,
      extra: Readonly<Record<string, string | undefined>> = {},
    ) =>
      Effect.gen(function* () {
        const values: Record<string, string | undefined> = {};
        for (const name of listPlaceholders(template)) {
          const value = name in extra ? extra[name] : readText(name);
          if (value === undefined) {
            return yield* refuse(
              `the ${purpose} "${template}" needs the field "${name}", which the observation did not report.`,
            );
          }
          values[name] = value;
        }
        return fillSentence(template, values)!;
      });

    const renderStatus = Effect.gen(function* () {
      const key = observation.status;
      if (key === undefined) return undefined;
      const status = declaration.status?.[key];
      if (status === undefined) {
        return yield* refuse(`the status "${key}" is not in the kind's status table.`);
      }
      return {
        shape: status.shape,
        tone: status.tone,
        label: status.word,
        ...(status.norm === undefined ? {} : { norm: status.norm }),
        // A place never becomes a Task, so only a kind with cards keeps the stage.
        ...(status.stage === undefined || declaration.pace === "context"
          ? {}
          : { stage: status.stage }),
      };
    });

    const status = yield* renderStatus;

    if (declaration.pace === "context") {
      return yield* decodeSlots({
        noun: declaration.noun,
        pace: "context",
        ...(declaration.groupable === undefined ? {} : { caption: declaration.groupable.caption }),
        ...(declaration.home === undefined ? {} : { home: declaration.home }),
        ...(declaration.section === undefined ? {} : { section: declaration.section }),
        ...(status === undefined ? {} : { status }),
      }).pipe(Effect.catch(refuseDecode(refuse)));
    }

    const personName = declaration.person === null ? undefined : readText(declaration.person);
    const ownerName = declaration.owner === null ? undefined : readText(declaration.owner);

    const readFact = (fact: EntityFactDeclaration) =>
      Effect.gen(function* () {
        const text = readText(fact.field);
        if (text === undefined) return undefined;
        const unreadable = () =>
          refuse(
            `the field "${fact.field}" holds ${JSON.stringify(text)}, which cannot be shown as a ${fact.form} fact.`,
          );
        switch (fact.form) {
          case "delta": {
            const match = DELTA_TEXT.exec(text);
            if (match === null) return yield* unreadable();
            return { form: "delta" as const, added: Number(match[1]), removed: Number(match[2]) };
          }
          case "count": {
            if (!/^\d+$/.test(text)) return yield* unreadable();
            return { form: "count" as const, value: Number(text), unit: fact.unit };
          }
          case "bars": {
            if (!/^\d$/.test(text)) return yield* unreadable();
            return { form: "bars" as const, level: Number(text) };
          }
          case "date":
            return { form: "date" as const, on: text };
          case "word":
            return { form: "word" as const, text };
          case "money":
            return { form: "money" as const, text };
        }
      });

    const facts = [];
    for (const declared of declaration.facts) {
      const fact = yield* readFact(declared);
      if (fact !== undefined) facts.push(fact);
    }

    const renderReason = Effect.gen(function* () {
      const key = observation.reason;
      if (key === undefined) return undefined;
      const reason = declaration.reasons[key];
      if (reason === undefined) {
        return yield* refuse(`the reason "${key}" is not in the kind's reasons.`);
      }
      const say = yield* fillTemplate(reason.say, `reason "${key}"`, { person: personName });
      return { say, tone: reason.tone };
    });

    const reason = yield* renderReason;

    // A reason named like a concern says why a thing concerns the user. One
    // that needs a field this thing lacks (a pull request with no author has no
    // `{person}`) is left out rather than refusing the observation.
    const concernReasons: Record<string, EntityReason> = {};
    for (const concern of ENTITY_CONCERNS) {
      const declared = declaration.reasons[concern];
      if (declared === undefined) continue;
      const say = Option.getOrUndefined(
        yield* Effect.option(
          fillTemplate(declared.say, `reason "${concern}"`, { person: personName }),
        ),
      );
      if (say !== undefined) concernReasons[concern] = { say, tone: declared.tone };
    }
    const identifier = yield* fillTemplate(declaration.identifier, "identifier");

    return yield* decodeSlots({
      noun: declaration.noun,
      card: declaration.card ?? "rich",
      pace: declaration.pace,
      patience: declaration.patience,
      ...(declaration.home === undefined ? {} : { home: declaration.home }),
      ...(declaration.section === undefined ? {} : { section: declaration.section }),
      identifier,
      ...(personName === undefined ? {} : { person: { name: personName } }),
      ...(ownerName === undefined ? {} : { owner: ownerName }),
      ...(status === undefined ? {} : { status }),
      facts,
      ...(reason === undefined ? {} : { reason }),
      ...(Object.keys(concernReasons).length === 0 ? {} : { concernReasons }),
      ...(Object.keys(declaration.reasons).length === 0
        ? {}
        : { reasonTemplates: declaration.reasons }),
    }).pipe(Effect.catch(refuseDecode(refuse)));
  });

/** Turns a failed decode of the rendered slots into the caller's refusal, listing every broken bound. */
const refuseDecode =
  <E>(refuse: (problem: string) => Effect.Effect<never, E>) =>
  (error: Schema.SchemaError) =>
    refuse(
      `a rendered value is out of bounds: ${listDecodeIssues(error).map(formatIssue).join("; ")}`,
    );
