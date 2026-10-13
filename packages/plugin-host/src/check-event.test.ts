/**
 * Tests the check a plugin runs on an event before it stores or emits it.
 */
import { describe, expect, it } from "vitest";
import { Effect, Result, Schema } from "effect";
import { checkEmittedEvent } from "./check-event";
import {
  MAX_EMITTED_FIELD_BYTES,
  type EmittedEvent,
  type EventKindDeclaration,
} from "./contributions";
import { MAX_DEDUP_KEY_LENGTH, MAX_EVENT_TITLE_LENGTH, MAX_EXTERNAL_REF_LENGTH } from "./limits";

/** The one kind an invented plugin declares. */
const KINDS: Record<string, EventKindDeclaration> = {
  "example.thing.changed": {
    description: "A thing changed.",
    schema: Schema.Struct({ name: Schema.String }),
    availableToTriage: true,
  },
};

/** Builds an event the host would accept. */
const buildValidEvent = (): EmittedEvent => ({
  kind: "example.thing.changed",
  dedupKey: "thing-1:changed:2026-10-12T09:00:00.000Z",
  occurredAt: "2026-10-12T09:00:00.000Z",
  payload: { name: "thing" },
  refs: ["example:thing:1"],
  url: "https://example.com/things/1",
  title: "Thing 1 changed",
  author: null,
});

const check = (event: EmittedEvent) =>
  Effect.runPromise(Effect.result(checkEmittedEvent(KINDS, event)));

describe("checkEmittedEvent", () => {
  it("accepts an event that keeps every limit", async () => {
    expect(Result.isSuccess(await check(buildValidEvent()))).toBe(true);
  });

  it.each([
    ["an undeclared kind", (event: EmittedEvent) => ({ ...event, kind: "example.thing.exploded" })],
    [
      "a dedup key over the limit",
      (event: EmittedEvent) => ({ ...event, dedupKey: "k".repeat(MAX_DEDUP_KEY_LENGTH + 1) }),
    ],
    ["an empty title", (event: EmittedEvent) => ({ ...event, title: "" })],
    [
      "a title over the limit",
      (event: EmittedEvent) => ({ ...event, title: "t".repeat(MAX_EVENT_TITLE_LENGTH + 1) }),
    ],
    [
      "a time without a zone",
      (event: EmittedEvent) => ({ ...event, occurredAt: "2026-10-12T09:00:00" }),
    ],
    ["a ref with a space", (event: EmittedEvent) => ({ ...event, refs: ["example:thing:1 2"] })],
    [
      "a ref over the limit",
      (event: EmittedEvent) => ({
        ...event,
        refs: [`example:thing:${"1".repeat(MAX_EXTERNAL_REF_LENGTH)}`],
      }),
    ],
    [
      "a payload with a field the kind does not declare",
      (event: EmittedEvent) => ({ ...event, payload: { name: "thing", extra: 1 } }),
    ],
    [
      "a payload over the byte limit",
      (event: EmittedEvent) => ({
        ...event,
        payload: { name: "x".repeat(MAX_EMITTED_FIELD_BYTES) },
      }),
    ],
    [
      "a raw over the byte limit",
      (event: EmittedEvent) => ({ ...event, raw: { body: "x".repeat(MAX_EMITTED_FIELD_BYTES) } }),
    ],
  ])("refuses %s, naming the kind", async (_name, change) => {
    const changed = change(buildValidEvent());

    const result = await check(changed);

    expect(Result.isFailure(result) && result.failure.message).toContain(`${changed.kind}:`);
  });
});
