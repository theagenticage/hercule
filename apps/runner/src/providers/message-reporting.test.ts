/**
 * Tests the label of an `unknown` item and the bounded log lines that report
 * unknown and deliberately unshown messages, which every adapter shares.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import { MAX_FACT_LENGTH } from "@hercule/protocol";
import {
  buildUnknownItemLabel,
  captureIgnoredMessageReporter,
  captureUnknownItemReporter,
} from "./message-reporting";

describe("buildUnknownItemLabel", () => {
  it("joins the harness prefix and the type text", () => {
    expect(buildUnknownItemLabel("claude", "system/foo_bar")).toBe("claude: system/foo_bar");
  });

  it("writes control, separator and direction characters as escapes", () => {
    expect(buildUnknownItemLabel("pi", "a\nb‮c d")).toBe("pi: a\\u{a}b\\u{202e}c\\u{2028}d");
  });

  it("truncates a label longer than a Fact, ending it with a marker", () => {
    const label = buildUnknownItemLabel("codex", "x".repeat(MAX_FACT_LENGTH));

    expect(label).toHaveLength(MAX_FACT_LENGTH);
    expect(label.endsWith("…")).toBe(true);
  });
});

describe("captureUnknownItemReporter", () => {
  /** Returns the reporter of a session and the warning lines it has written so far. */
  const startReporting = async () => {
    const warnings: Array<string> = [];
    const collecting = Logger.make<unknown, void>(({ logLevel, message }) => {
      if (logLevel === "Warn") warnings.push(String(message));
    });
    const report = await Effect.runPromise(
      Effect.provide(captureUnknownItemReporter("Pi", "session-1"), Logger.layer([collecting])),
    );
    return { report, warnings };
  };

  it("writes one line per label, naming the harness", async () => {
    const { report, warnings } = await startReporting();

    report("pi: foo");
    report("pi: foo");
    report("pi: bar");
    await Promise.resolve();

    expect(warnings).toEqual([
      "Pi sent a message type this runner has no decision for: pi: foo",
      "Pi sent a message type this runner has no decision for: pi: bar",
    ]);
  });

  it("adds what failed when the message could not be read", async () => {
    const { report, warnings } = await startReporting();

    report("pi: foo", new Error("field is not text"));
    await Promise.resolve();

    expect(warnings).toEqual([
      "Pi sent a message this runner could not read: pi: foo. Error: field is not text",
    ]);
  });

  it("stops writing lines after 100 different labels, with one line that says so", async () => {
    const { report, warnings } = await startReporting();

    for (let index = 0; index < 103; index += 1) report(`pi: foo_${index}`);
    // The first label again: already logged, so it adds nothing.
    report("pi: foo_0");
    await Promise.resolve();

    expect(warnings).toHaveLength(101);
    expect(warnings[0]).toBe("Pi sent a message type this runner has no decision for: pi: foo_0");
    expect(warnings[99]).toBe("Pi sent a message type this runner has no decision for: pi: foo_99");
    expect(warnings[100]).toBe(
      "Pi sent more than 100 different unknown message types in this session. Further ones are not logged.",
    );
  });
});

describe("captureIgnoredMessageReporter", () => {
  it("writes one line per key and stops after the same bound as the other reporter", async () => {
    const warnings: Array<string> = [];
    const collecting = Logger.make<unknown, void>(({ logLevel, message }) => {
      if (logLevel === "Warn") warnings.push(String(message));
    });
    const report = await Effect.runPromise(
      Effect.provide(captureIgnoredMessageReporter("session-1"), Logger.layer([collecting])),
    );

    report("late item/started", "first");
    report("late item/started", "again");
    for (let count = 0; count < 150; count += 1) report(`key ${count}`, `line ${count}`);
    await Promise.resolve();

    expect(warnings[0]).toBe("first");
    expect(warnings.filter((line) => line === "again")).toEqual([]);
    expect(warnings).toHaveLength(100);
  });
});
