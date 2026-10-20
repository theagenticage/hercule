/**
 * The provenance entry the controller's own code may write.
 */
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { ProvenanceEntry } from "@hercule/contract";

/**
 * A provenance entry as controller code writes it: the fields of a stored
 * entry that the core does not stamp itself, so `ref`, `eventId`, `runId` and
 * `signalId`. Fails to decode an entry that has none of them.
 *
 * The public `ProvenanceInput` in the contract refuses `signalId`, so only
 * code inside the controller can record a handoff. The fields come from
 * `ProvenanceEntry`, so the two cannot drift apart.
 */
export const CoreProvenanceInput = Schema.Struct(
  Struct.pick(ProvenanceEntry.fields, ["ref", "eventId", "runId", "signalId"]),
).check(
  Schema.makeFilter((entry) =>
    entry.ref === undefined &&
    entry.eventId === undefined &&
    entry.runId === undefined &&
    entry.signalId === undefined
      ? "A provenance entry must include at least one of ref, eventId, runId and signalId."
      : undefined,
  ),
);
