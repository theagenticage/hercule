/**
 * Tests the check the feed runs on every event before it writes the outbox.
 */
import { describe, expect, it } from "vitest";
import { Effect, Result, Schema } from "effect";
import {
  MAX_DEDUP_KEY_LENGTH,
  MAX_EMITTED_FIELD_BYTES,
  MAX_EXTERNAL_REF_LENGTH,
  type EmittedEvent,
} from "@hercule/plugin-host";
import { ApiIssue, buildIssueBlock } from "../sentry-objects";
import { buildFakeIssue, buildFakeWorld, renderFakeIssue } from "../testing";
import { checkEmittedEvent } from "./check-event";
import { buildIssueEvent } from "./events";

/** Builds a valid `entered` event for an invented issue. */
const buildValidEvent = (): EmittedEvent => {
  const issue = buildFakeIssue("1001");
  const block = buildIssueBlock(
    Schema.decodeUnknownSync(ApiIssue)(renderFakeIssue(buildFakeWorld([issue]), issue)),
  );
  return buildIssueEvent({
    kind: "entered",
    organization: { id: "4501", slug: "acme" },
    issue: block,
    fields: { toYou: false },
    dedupKey: "1001:entered:2026-10-12T09:00:00.000Z",
    occurredAt: "2026-10-12T09:00:00.000Z",
    fallbackTime: "2026-10-12T09:00:00.000Z",
  });
};

const check = (event: EmittedEvent) => Effect.runPromise(Effect.result(checkEmittedEvent(event)));

describe("checkEmittedEvent", () => {
  it("accepts an event built the way the feed builds one", async () => {
    expect(Result.isSuccess(await check(buildValidEvent()))).toBe(true);
  });

  it.each([
    ["an undeclared kind", (event: EmittedEvent) => ({ ...event, kind: "sentry.issue.exploded" })],
    [
      "a dedup key over the limit",
      (event: EmittedEvent) => ({ ...event, dedupKey: "k".repeat(MAX_DEDUP_KEY_LENGTH + 1) }),
    ],
    ["an empty title", (event: EmittedEvent) => ({ ...event, title: "" })],
    ["a title over the limit", (event: EmittedEvent) => ({ ...event, title: "t".repeat(513) })],
    [
      "a time without a zone",
      (event: EmittedEvent) => ({ ...event, occurredAt: "2026-10-12T09:00:00" }),
    ],
    [
      "a ref with a space",
      (event: EmittedEvent) => ({ ...event, refs: ["sentry:issue:4501/1 2"] }),
    ],
    [
      "a ref over the limit",
      (event: EmittedEvent) => ({
        ...event,
        refs: [`sentry:issue:${"1".repeat(MAX_EXTERNAL_REF_LENGTH)}`],
      }),
    ],
    [
      "a payload with a field the kind does not declare",
      (event: EmittedEvent) => ({ ...event, payload: { ...(event.payload as object), extra: 1 } }),
    ],
    [
      "a payload over the byte limit",
      (event: EmittedEvent) => ({
        ...event,
        payload: { ...(event.payload as object), toYou: "x".repeat(MAX_EMITTED_FIELD_BYTES) },
      }),
    ],
  ])("refuses %s", async (_name, change) => {
    const result = await check(change(buildValidEvent()));

    expect(Result.isFailure(result) && result.failure.message).toContain("sentry.issue.");
  });
});
