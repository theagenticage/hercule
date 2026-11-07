import * as Effect from "effect/Effect";
import { nowIso } from "../../db";
import type { PluginHost } from "../../plugins";

/**
 * Returns what decides whether a place above a linked thing can be read now:
 * the time, the plugins that are running and their entity kinds. The board and the details pane
 * read it the same way, so a place that only a stopped plugin could refresh
 * counts as stale on both.
 */
export const readEntityEnvironment = (host: PluginHost["Service"]) =>
  Effect.gen(function* () {
    const sources = yield* host.listActiveEventSources();
    return {
      now: yield* nowIso,
      activePluginIds: [...new Set(sources.map((source) => source.pluginId))],
      activeEntityKinds: sources.flatMap((source) =>
        source.entityKinds.map(({ word, noun, refPrefix }) => ({ kind: word, noun, refPrefix })),
      ),
    };
  });
