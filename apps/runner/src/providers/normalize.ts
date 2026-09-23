/**
 * The parts of normalizing harness events that are the same for every harness:
 *
 * - the fields every event has;
 * - converting a vendor payload to plain JSON the protocol can encode;
 * - clamping counts.
 *
 * They live here rather than in one adapter's folder so that adapters cannot
 * drift apart. A payload one adapter fails to convert is a frame the runner
 * cannot encode, and the runner drops an event it cannot encode.
 */
import type * as Schema from "effect/Schema";
import { now } from "../report";

/** The fields every normalized event has. */
export interface Envelope {
  readonly eventId: string;
  readonly sessionId: string;
  readonly at: string;
  readonly providerRefs: Readonly<Record<string, string>>;
}

/**
 * Converts a value to plain JSON with a real round trip, not a type cast. A
 * single `undefined` property anywhere in a vendor payload would make the frame
 * fail to encode.
 */
export const toJson = (value: unknown): Schema.Json =>
  JSON.parse(JSON.stringify(value ?? null)) as Schema.Json;

/**
 * Converts a value to a count the protocol accepts: a whole number, never negative. Anything else
 * becomes 0.
 */
export const clampCount = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/**
 * Returns a new envelope with the harness's own ids for its work. The caller
 * chooses the keys, because harnesses use different ids: one uses a thread,
 * another a session.
 */
export const buildEnvelope = (
  sessionId: string,
  providerRefs: Readonly<Record<string, string>>,
): Envelope => ({
  eventId: crypto.randomUUID(),
  sessionId,
  at: now(),
  providerRefs,
});

/**
 * Returns the harness payload an event was built from, for a reader who wants
 * the harness's original output. Not used for deltas: a turn has thousands of
 * them, and a copy on each would double the stream for a payload that is the
 * delta itself.
 */
export const buildRaw = (
  source: string,
  payload: unknown,
): { readonly raw: { readonly source: string; readonly payload: Schema.Json } } => ({
  raw: { source, payload: toJson(payload) },
});
