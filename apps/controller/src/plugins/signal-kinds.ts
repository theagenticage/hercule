/**
 * Checks the signal kinds an event source declares, and returns them
 * qualified with the plugin's id, ready for the core to raise and end
 * signals from the source's events (spec 10 §9.2).
 *
 * Everything in a declaration except `build` is data the core evaluates, so
 * the host checks all of it when the plugin loads. A mistake then refuses the
 * source while the plugin's author reads the error, instead of failing on
 * every event later, where only the logs would show it.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  MAX_PLUGIN_MESSAGE_LENGTH,
  MAX_SIGNAL_TITLE_LENGTH,
  SignalKind,
  TaskPriority,
} from "@hercule/contract";
import {
  EventSourceNames,
  PluginError,
  type PluginManifest,
  type SignalKindDeclaration,
} from "@hercule/plugin-host";
import { validateCondition, validateExpression, type ExpressionError } from "../expressions";
import { describeFieldIssues } from "./errors";

/**
 * A signal kind a plugin registered at boot: its declaration, with the
 * qualified kind (`github/review-requested`), the plugin that owns it, and
 * the plugin's display name, which the Done action's describe line names.
 */
export interface RegisteredSignalKind extends SignalKindDeclaration {
  readonly kind: string;
  readonly pluginId: string;
  readonly pluginDisplayName: string;
}

/**
 * The data fields of a declaration that are shown to the user or stored. A
 * signal written without the plugin's `build` takes the label as its title,
 * so the label obeys a title's limit.
 */
const SignalKindHeader = Schema.Struct({
  word: EventSourceNames.fields.id,
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_SIGNAL_TITLE_LENGTH)),
  description: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_PLUGIN_MESSAGE_LENGTH),
  ),
  priority: TaskPriority,
});

const decodeSignalKindHeader = Schema.decodeUnknownEffect(SignalKindHeader, { errors: "all" });

const decodeSignalKind = Schema.decodeUnknownEffect(SignalKind, { errors: "all" });

/**
 * Decodes the signal kinds of one event source, and returns them qualified.
 * `eventKinds` are the event kinds the source declares, and `taken` the
 * qualified signal kinds the plugin's other sources already registered.
 * Fails with a `PluginError` naming the kind when:
 *
 * - its word, label, description or priority is invalid, or the qualified
 *   kind is not a valid signal kind;
 * - another signal kind of the plugin has the same word;
 * - a `from` event kind, or an end's event kind, is not one this source
 *   declares. The core only reads this source's events for the kind;
 * - an expression (the rule, the thread, a match field's path, an end's
 *   condition or outcome) does not parse, or reads a variable other than
 *   `event`.
 */
export const decodeSignalKinds = (
  manifest: PluginManifest,
  sourceId: string,
  declarations: ReadonlyArray<SignalKindDeclaration>,
  eventKinds: ReadonlySet<string>,
  taken: ReadonlySet<string>,
): Effect.Effect<ReadonlyArray<RegisteredSignalKind>, PluginError> =>
  Effect.gen(function* () {
    const registered: Array<RegisteredSignalKind> = [];
    for (const declaration of declarations) {
      const invalid = (reason: string) =>
        new PluginError({
          message: `the signal kind ${declaration.word} of the event source ${sourceId} is invalid: ${reason}`,
        });
      yield* Effect.mapError(decodeSignalKindHeader(declaration), (error) =>
        invalid(describeFieldIssues(error)),
      );
      const kind = `${manifest.id}/${declaration.word}`;
      yield* Effect.mapError(decodeSignalKind(kind), (error) =>
        invalid(describeFieldIssues(error)),
      );
      if (taken.has(kind) || registered.some((other) => other.kind === kind)) {
        return yield* Effect.fail(
          new PluginError({
            message: `the signal kind ${kind} is declared twice. Give each signal kind of the plugin its own word.`,
          }),
        );
      }
      const foreign = [...declaration.from, ...declaration.ends.map((end) => end.eventKind)].find(
        (eventKind) => !eventKinds.has(eventKind),
      );
      if (foreign !== undefined) {
        return yield* Effect.fail(
          invalid(
            `it reads the event kind ${foreign}, which the source does not declare. List only the source's own kinds in from and in ends.`,
          ),
        );
      }
      const expressions: ReadonlyArray<readonly [string, Effect.Effect<void, ExpressionError>]> = [
        ["rule", validateExpression(declaration.rule, "event")],
        ["threadRef", validateExpression(declaration.threadRef, "event")],
        ...declaration.matchFields.map(
          (field) =>
            [
              `the path of the match field ${field.name}`,
              validateExpression(field.path, "event"),
            ] as const,
        ),
        ...declaration.ends.flatMap((end) => [
          ...(end.condition === undefined
            ? []
            : [
                [
                  `the condition of the end on ${end.eventKind}`,
                  validateCondition(end.condition, "event"),
                ] as const,
              ]),
          [
            `the outcome of the end on ${end.eventKind}`,
            validateExpression(end.outcome, "event"),
          ] as const,
        ]),
      ];
      for (const [name, validation] of expressions) {
        yield* Effect.mapError(validation, (error) => invalid(`${name}: ${error.message}`));
      }
      registered.push({
        ...declaration,
        kind,
        pluginId: manifest.id,
        pluginDisplayName: manifest.displayName,
      });
    }
    return registered;
  });
