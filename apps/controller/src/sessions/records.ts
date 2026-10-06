/**
 * Converts a stored session into the `Session` record the API returns.
 *
 * Every field on the record comes from the row, except `unenforced` and
 * `resumeHeld`. Each open Request a subagent asked also gets that
 * subagent's name, from the names the row was read with. `resumeHeld` is the crash-loop guard's rule applied to the
 * row, so every reader of the record agrees with the controller about it. The list
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
import * as Struct from "effect/Struct";
import type { Session, SessionRequest } from "@hercule/contract";
import { PluginHost } from "../plugins";
import { listUnenforcedFields } from "../providers";
import type { StoredSession } from "./repository";
import { buildUsageFields } from "./usage";
import { isResumeHeld } from "./resume-hold";

/**
 * Returns `request` with the name of the subagent that asked it, looked up
 * in `subagentNames`. Returns it unchanged when the session's own agent
 * asked, or when the subagent has no name yet.
 */
const addSubagentName = (
  request: SessionRequest,
  subagentNames: StoredSession["subagentNames"],
): SessionRequest => {
  const name = request.subagentId === undefined ? undefined : subagentNames.get(request.subagentId);
  return name === undefined ? request : { ...request, subagentName: name };
};

export const sessionRecordComposer: Effect.Effect<
  Effect.Effect<(stored: StoredSession) => Session>,
  never,
  PluginHost
> = Effect.gen(function* () {
  const host = yield* PluginHost;

  return Effect.map(host.providers(), (definitions) => (stored: StoredSession): Session => ({
    ...Struct.omit(stored, [
      "providerId",
      "disallowedTools",
      "crashGuardArmed",
      "inputWaiting",
      "conversationDeleted",
      "usage",
      "usageProcess",
      "openRequests",
      "subagentNames",
    ]),
    openRequests: stored.openRequests.map((request) =>
      addSubagentName(request, stored.subagentNames),
    ),
    ...buildUsageFields(stored.usage),
    resumeHeld: isResumeHeld(stored),
    unenforced: listUnenforcedFields(definitions, stored.providerId, stored.disallowedTools),
  }));
});
