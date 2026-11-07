/**
 * A stand-in for the Signal Entities port, for tests of the signals domain
 * that do not need the External Entity records.
 */
import type { SignalEntity } from "@hercule/contract";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SignalEntities } from "./signal-entities";

/** What a stand-in port was asked, in the order it was asked. */
export interface SignalEntitiesCalls {
  /** The refs of each `readByRefs` call. */
  readonly reads: Array<ReadonlyArray<string>>;
  /** The ref of each `recordArrival` call. */
  readonly arrivals: Array<string>;
}

/**
 * Builds a layer that answers `SignalEntities` from `entityByRef`, with no
 * entity for any other ref, and records every call it gets.
 */
export const buildSignalEntitiesDouble = (
  entityByRef: ReadonlyMap<string, SignalEntity> = new Map(),
): { readonly layer: Layer.Layer<SignalEntities>; readonly calls: SignalEntitiesCalls } => {
  const calls: SignalEntitiesCalls = { reads: [], arrivals: [] };
  const layer = Layer.succeed(SignalEntities)({
    readByRefs: (refs) =>
      Effect.sync(() => {
        calls.reads.push(refs);
        return new Map(
          refs.flatMap((ref) => {
            const entity = entityByRef.get(ref);
            return entity === undefined ? [] : [[ref, entity] as const];
          }),
        );
      }),
    recordArrival: (ref) =>
      Effect.sync(() => {
        calls.arrivals.push(ref);
      }),
  });
  return { layer, calls };
};
