/**
 * Tests the text a matched event is rendered as when it becomes a session
 * input.
 *
 * The text is the only part of a delivery a person or an agent reads, so it
 * is tested on its own, without a fleet: one line that describes the event,
 * then the payload as JSON the agent can act on without another call.
 *
 * The payload has no fixed schema, so there are three cases:
 *
 * - a payload with a subject, and an event with a URL;
 * - a payload with neither;
 * - an empty payload.
 *
 * A renderer that turned a missing field into "undefined" would write that
 * word into an agent's turn.
 */
import { describe, expect, it } from "vitest";
import type { Event } from "@hercule/contract";
import { renderEventInput } from "./render-event-input";

/** Builds an event with the fields the core sets already filled in. */
const buildEvent = (fields: Partial<Event>): Event => ({
  id: 41,
  source: "manual",
  connectionId: null,
  system: "github",
  kind: "github.pr.merged",
  occurredAt: "2026-09-21T10:00:00.000Z",
  receivedAt: "2026-09-21T10:00:00.000Z",
  dedupKey: "one",
  refs: ["github:pr:o/r#87"],
  url: null,
  payload: {},
  raw: null,
  actor: "user",
  ...fields,
});

const readFirstLine = (text: string): string => text.split("\n")[0]!;

/** Parses the payload back out of the text's fenced JSON block. */
const readFencedPayload = (text: string): unknown => {
  const fence = /```json\n([\s\S]*?)\n```/.exec(text);
  expect(fence, `no fenced JSON block in:\n${text}`).not.toBeNull();
  return JSON.parse(fence![1]!) as unknown;
};

describe("renderEventInput", () => {
  it("writes the kind, the subject's title and the URL on one line, followed by the payload", () => {
    const payload = {
      subject: {
        repo: "o/r",
        number: 87,
        title: "The lid does not close",
        url: "https://github.com/o/r/pull/87",
      },
    };
    const text = renderEventInput(
      buildEvent({ kind: "github.pr.merged", url: "https://github.com/o/r/pull/87", payload }),
    );

    const line = readFirstLine(text);
    expect(line).toContain("github.pr.merged");
    expect(line).toContain("The lid does not close");
    expect(line).toContain("https://github.com/o/r/pull/87");
    expect(text.split("\n")).not.toHaveLength(1);
    expect(readFencedPayload(text)).toEqual(payload);
  });

  it("writes only the kind when the payload has no subject and the event has no URL", () => {
    const payload = { reason: "mention" };
    const text = renderEventInput(buildEvent({ kind: "github.notification", url: null, payload }));

    const line = readFirstLine(text);
    expect(line).toContain("github.notification");
    // A missing field is left out, not written as "undefined".
    expect(line).not.toMatch(/undefined|null/);
    expect(readFencedPayload(text)).toEqual(payload);
  });

  it("still includes an empty payload, as an empty JSON object", () => {
    const text = renderEventInput(buildEvent({ kind: "github.pr.closed", url: null, payload: {} }));

    expect(readFirstLine(text)).toContain("github.pr.closed");
    expect(readFencedPayload(text)).toEqual({});
  });
});
