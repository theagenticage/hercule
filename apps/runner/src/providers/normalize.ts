/**
 * The parts of normalizing a harness's events that are the same whichever
 * harness it is: what every event carries, what a vendor payload has to be cut
 * down to before the protocol will encode it, and what a count has to be.
 *
 * It lives here rather than in one adapter's folder because two adapters
 * holding their own copy is two of them drifting: a payload one of them does
 * not round-trip is a frame the runner cannot encode, and an event that will
 * not encode is one the runner drops.
 */
import type * as Schema from "effect/Schema";
import { now } from "../report";

/** What every event off a normalizer carries, whatever else it says. */
export interface Envelope {
  readonly eventId: string;
  readonly sessionId: string;
  readonly at: string;
  readonly providerRefs: Readonly<Record<string, string>>;
}

/**
 * A real round-trip, not a cast: one `undefined` property anywhere in a vendor
 * payload would be a frame the protocol refuses to encode.
 */
export const json = (value: unknown): Schema.Json =>
  JSON.parse(JSON.stringify(value ?? null)) as Schema.Json;

/** A count the protocol will carry: a whole number, never negative. */
export const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/**
 * The envelope, with the native ids this harness names its own work by: a
 * thread for one, a session for another, so the key is the caller's.
 */
export const enveloped = (
  sessionId: string,
  providerRefs: Readonly<Record<string, string>>,
): Envelope => ({
  eventId: crypto.randomUUID(),
  sessionId,
  at: now(),
  providerRefs,
});

/**
 * What the event was read off, for a reader that wants what the harness
 * actually said. Not on a delta: a turn is thousands of them, and a copy on
 * each would double the stream for a payload that is the delta itself.
 */
export const rawOf = (
  source: string,
  payload: unknown,
): { readonly raw: { readonly source: string; readonly payload: Schema.Json } } => ({
  raw: { source, payload: json(payload) },
});
