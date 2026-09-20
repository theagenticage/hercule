/**
 * Composes a stored session into the record the API hands over.
 *
 * Every field on the record is the row, except `unenforced`. Which parts of
 * the spec the session's provider ignores is read from that provider's
 * declaration at every read, so a binary whose adapter learned to enforce a
 * field stops reporting that field.
 *
 * It is an effect rather than a plain function because the declarations live
 * in the plugin host. Every caller outside this domain composes a session
 * record here, so two callers that read one row can never disagree about what
 * the row means.
 *
 * There are two effects, one inside the other, and both levels matter. The
 * outer effect takes the plugin host, once, where the service is built. The
 * inner effect takes the provider catalog, once per call, so a page of
 * sessions is composed against one catalog instead of one catalog per row.
 */
import * as Effect from "effect/Effect";
import type { Session } from "@hercule/contract";
import { PluginHost } from "../plugins";
import { listUnenforcedFields } from "../providers";
import type { StoredSession } from "./repository";

export const sessionRecordComposer: Effect.Effect<
  Effect.Effect<(stored: StoredSession) => Session>,
  never,
  PluginHost
> = Effect.gen(function* () {
  const host = yield* PluginHost;

  return Effect.map(
    host.providers(),
    (definitions) =>
      ({ providerId, disallowedTools, ...session }: StoredSession): Session => ({
        ...session,
        unenforced: listUnenforcedFields(definitions, providerId, disallowedTools),
      }),
  );
});
