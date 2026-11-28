import { Effect } from "effect";
import { MAX_CONTRIBUTION_NAME_LENGTH, PluginError } from "@hercule/plugin-host";

/**
 * Builds the qualified id of a contribution: the plugin's id, a `/` and the
 * word the plugin declared (ADR 0034). Nothing splits the result again.
 *
 * Fails with a `PluginError` naming `noun` (such as "harness") when the id is
 * longer than a catalog column allows. The word alone passed the limit, but
 * the qualified id is stored in a column with the same limit. Refusing here
 * refuses this plugin; a row the database rejects would stop the whole boot.
 */
export const mintQualifiedId = (
  pluginId: string,
  noun: string,
  word: string,
): Effect.Effect<string, PluginError> => {
  const id = `${pluginId}/${word}`;
  return id.length > MAX_CONTRIBUTION_NAME_LENGTH
    ? Effect.fail(
        new PluginError({
          message: `the ${noun} id ${id} is ${String(id.length)} characters long, and the limit is ${String(MAX_CONTRIBUTION_NAME_LENGTH)}. The id is the plugin id, a "/" and the ${noun}'s own id, so shorten the ${noun}'s id.`,
        }),
      )
    : Effect.succeed(id);
};
