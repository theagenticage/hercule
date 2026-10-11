/**
 * Test helpers that read signals the way the user does, through the public
 * API, and wait for the event pipeline to raise or end one.
 */
import { expect } from "vitest";
import type { Signal, SignalPage } from "@hercule/contract";
import { get } from "../http/testing";
import { waitUntil } from "../sessions/testing";

/** The address of a running controller and the user's token. */
export interface SignalReader {
  readonly base: string;
  readonly token: string;
}

/** Returns the open signals of one kind, such as `github/mentioned`. */
export const listOpenSignals = async (
  { base, token }: SignalReader,
  kind: string,
): Promise<ReadonlyArray<Signal>> => {
  const response = await get(base, `/api/v1/signals?kind=${encodeURIComponent(kind)}`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as SignalPage).items;
};

/** Reads one signal, or fails the test when the controller does not return it. */
export const readSignal = async ({ base, token }: SignalReader, id: string): Promise<Signal> => {
  const response = await get(base, `/api/v1/signals/${id}`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Signal;
};

/** Waits until an open signal of the kind was raised from the event, and returns it. */
export const waitForSignalFrom = (
  reader: SignalReader,
  kind: string,
  eventId: number,
): Promise<Signal> =>
  waitUntil(`raised a ${kind} signal from the event ${String(eventId)}`, async () =>
    (await listOpenSignals(reader, kind)).find(
      (signal) => signal.origin.type === "event" && signal.origin.eventId === eventId,
    ),
  );

/** Waits until the signal is resolved, and returns it. */
export const waitForResolved = (reader: SignalReader, id: string): Promise<Signal> =>
  waitUntil(`resolved the signal ${id}`, async () => {
    const signal = await readSignal(reader, id);
    return signal.status === "open" ? undefined : signal;
  });
