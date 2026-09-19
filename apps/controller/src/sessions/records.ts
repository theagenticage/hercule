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
 */
import * as Effect from "effect/Effect";
import type { Session } from "@hydra/contract";
import { PluginHost } from "../plugins";
import { unenforcedFieldsOf } from "../providers";
import type { StoredSession } from "./repository";

export const sessionRecordReader: Effect.Effect<
  (stored: StoredSession) => Effect.Effect<Session>,
  never,
  PluginHost
> = Effect.gen(function* () {
  const host = yield* PluginHost;

  return ({ providerId, disallowedTools, ...session }: StoredSession) =>
    Effect.map(host.providers(), (definitions) => {
      const definition = definitions.find((one) => one.id === providerId);
      return {
        ...session,
        // An instance that is gone, or a provider this build no longer carries,
        // says nothing about what it would have enforced.
        unenforced: definition === undefined ? [] : unenforcedFieldsOf(definition, disallowedTools),
      };
    });
});
