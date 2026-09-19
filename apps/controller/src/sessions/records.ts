/**
 * A stored session as the API hands it over.
 *
 * The one thing a row does not carry is `unenforced`: what the session's
 * provider will ignore of the spec it was given is read from that provider's
 * declaration at every read, so a binary whose adapter learned to enforce a
 * field stops saying it will not. Everything else on the record is the row.
 *
 * It is a reader rather than a plain function because the declarations live in
 * the plugin host, and it is the one way out of this domain so that two callers
 * reading the same row can never disagree about what it means.
 *
 * Two levels, and both are the point: the outer effect is the host, taken once
 * where the service is built, and the inner one is the provider catalog, taken
 * once per call - so a page of sessions is read against one catalog rather
 * than one read per row.
 */
import * as Effect from "effect/Effect";
import type { Session } from "@hydra/contract";
import { PluginHost } from "../plugins";
import { unenforcedFieldsIn } from "../providers";
import type { StoredSession } from "./repository";

export const sessionRecordReader: Effect.Effect<
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
        unenforced: unenforcedFieldsIn(definitions, providerId, disallowedTools),
      }),
  );
});
