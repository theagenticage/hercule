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
  EntityKindDeclaration,
  PluginError,
  QualifiedEntityKindDeclaration,
  type PluginManifest,
} from "@hercule/plugin-host";
import { describeFieldIssues } from "./errors";

/** A kind that another source of the plugin, or another plugin, has already registered. */
export interface TakenEntityKinds {
  /** The qualified words the plugin's other sources declared. */
  readonly words: ReadonlySet<string>;
  /** The ref prefixes of every kind registered so far, in any plugin, with the kind that owns each. */
  readonly refPrefixes: ReadonlyArray<{ readonly kind: string; readonly refPrefix: string }>;
}

const decodeDeclaration = Schema.decodeUnknownEffect(EntityKindDeclaration, { errors: "all" });

const decodeQualified = Schema.decodeUnknownEffect(QualifiedEntityKindDeclaration, {
  errors: "all",
});

/**
 * Decodes the entity kinds of one event source, and returns them qualified.
 * A plugin writes its own words unqualified, `pull-request`, in `word`, `home`
 * and `section`. The host qualifies all three with the plugin's id, so
 * `pull-request` becomes `github/pull-request`.
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
 * - its `home` or `section` is not the word of a kind of this same source.
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
      prefixes.push({ kind, refPrefix: declaration.refPrefix });
      registered.push(
        yield* Effect.mapError(
          decodeQualified({
            ...declaration,
            word: kind,
            ...(declaration.home === undefined ? {} : { home: qualify(declaration.home) }),
            ...(declaration.section === undefined ? {} : { section: qualify(declaration.section) }),
          }),
          (error) => invalid(describeFieldIssues(error)),
        ),
      );
    }
    return registered;
  });
