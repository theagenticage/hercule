/**
 * What a matched event reads like when it arrives as a session's input.
 *
 * The text is the only part of a delivery a person or an agent ever reads, so
 * it is pinned on its own, away from the fleet: one line that says what
 * happened, and the payload underneath it as JSON the agent can act on without
 * another call.
 *
 * Three envelopes, because the payload is loose by design: a kind whose payload
 * names a subject and a URL, a kind whose payload names neither, and a kind
 * whose payload is empty. A renderer that reads a missing field as the word
 * "undefined" writes that word into an agent's turn.
 */
import { describe, expect, it } from "vitest";
import type { Event } from "@hercule/contract";
import { renderEventInput } from "./render-event-input";

/** An envelope with the core's own fields already stamped. */
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

/** The payload the text carries, read back out of its fenced JSON block. */
const readFencedPayload = (text: string): unknown => {
  const fence = /```json\n([\s\S]*?)\n```/.exec(text);
  expect(fence, `no fenced JSON block in:\n${text}`).not.toBeNull();
  return JSON.parse(fence![1]!) as unknown;
};

describe("renderEventInput", () => {
  it("names the kind, the subject's title and the URL on one line, and carries the payload", () => {
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

  it("names the kind alone when the payload has no subject and the event has no URL", () => {
    const payload = { reason: "mention" };
    const text = renderEventInput(buildEvent({ kind: "github.notification", url: null, payload }));

    const line = readFirstLine(text);
    expect(line).toContain("github.notification");
    // A field that is not there is left out, rather than written out as the
    // word a template produces for a missing value.
    expect(line).not.toMatch(/undefined|null/);
    expect(readFencedPayload(text)).toEqual(payload);
  });

  it("still carries an empty payload, as an empty JSON object", () => {
    const text = renderEventInput(buildEvent({ kind: "github.pr.closed", url: null, payload: {} }));

    expect(readFirstLine(text)).toContain("github.pr.closed");
    expect(readFencedPayload(text)).toEqual({});
  });
});
