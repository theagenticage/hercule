/**
 * Converts a stored session into the `Session` record the API returns.
 *
 * Every field on the record comes from the row, except `unenforced`. The list
 * of spec fields the session's provider ignores is read from the provider
 * definition on every read. So when a new binary's adapter starts enforcing a
 * field, the field drops off the list.
 *
 * `sessionRecordComposer` is an effect rather than a plain function because
 * the provider definitions live in the plugin host. Every caller outside this
 * domain builds session records here, so two callers that read the same row
 * always agree on what it means.
 *
 * There are two effects, one inside the other, and both levels matter:
 *
 * - The outer effect reads the plugin host once, when the service is built.
 * - The inner effect reads the provider definitions once per call, so a page
 *   of sessions is built against one list of definitions instead of one per
 *   row.
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
