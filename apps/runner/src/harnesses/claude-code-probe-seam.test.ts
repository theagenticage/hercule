/**
 * Tests the real Claude Code seam's probe against a stand-in for the vendor
 * SDK's `query()` that behaves like SDK 0.3.263: once the prompt iterable
 * ends, the query is closed, and a control request sent after that fails with
 * "Query closed before response received". The stubbed-seam tests in
 * `claude-code.test.ts` cannot catch this, because they replace the code that
 * builds the prompt.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { claudeCode } from "./claude-code";
import * as testing from "./testing";

interface RunningQuery {
  /** Returns whether the prompt iterable has ended, which closes the query in the SDK. */
  readonly hasPromptEnded: () => boolean;
  /** The messages the prompt yielded. The probe must never send one, or the SDK bills a turn. */
  readonly sentMessages: ReadonlyArray<unknown>;
}

const queries: Array<RunningQuery> = [];

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const original = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return {
    ...original,
    query: ({ prompt }: { prompt: AsyncIterable<unknown>; options: Options }) => {
      let ended = false;
      const sentMessages: Array<unknown> = [];
      void (async () => {
        for await (const message of prompt) sentMessages.push(message);
        ended = true;
      })();
      queries.push({ hasPromptEnded: () => ended, sentMessages });
      return {
        accountInfo: () => Promise.resolve({ email: "rogier@example.com" }),
        supportedModels: () => Promise.resolve([]),
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
          // Let the prompt iterable end first, if it is going to.
          await new Promise((resolve) => setTimeout(resolve, 10));
          if (ended) throw new Error("Query closed before response received");
          return {
            rate_limits_available: true,
            rate_limits: {
              five_hour: { utilization: 25, resets_at: "2026-10-31T12:00:00.000Z" },
              seven_day: null,
            },
          };
        },
        return: () => Promise.resolve({ done: true, value: undefined }),
      };
    },
  };
});

const folders: Array<string> = [];

afterAll(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** Creates a temporary folder that `afterAll` removes, and returns its path. */
const makeFolder = (prefix: string): string => {
  const folder = mkdtempSync(join(tmpdir(), prefix));
  folders.push(folder);
  return folder;
};

/** Writes a stand-in `claude` that only answers `--version`, and returns its path. */
const writeVersionOnlyBinary = (): string => {
  const folder = makeFolder("hercule-claude-probe-seam-");
  const path = join(folder, "claude");
  writeFileSync(path, "#!/bin/sh\necho '9.9.9 (Claude Code)'\n");
  chmodSync(path, 0o755);
  return path;
};

describe("the Claude Code probe's own query", () => {
  it("keeps the query open while it reads usage, and ends it when the probe is done", async () => {
    const probed = await Effect.runPromise(
      claudeCode.probe(
        {
          cwd: null,
          attachmentsDir: null,
          editMarks: null,
          home: makeFolder("hercule-claude-probe-seam-home-"),
          binary: writeVersionOnlyBinary(),
          env: { PATH: process.env["PATH"] ?? "" },
          modelArgument: "{model}",
          credentialVariables: [],
          herculeTool: { orientation: "", skill: "", claudePluginDir: "/nonexistent" },
          attachmentUploader: testing.NO_CONTROLLER_UPLOADER,
        },
        { readUsage: true },
      ),
    );

    expect(probed.usage).toMatchObject([{ kind: "window", window: "five-hour", usedPercent: 25 }]);
    expect(queries).toHaveLength(1);
    // The prompt ends in the microtasks after `close`, so let them run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queries[0]!.hasPromptEnded()).toBe(true);
    expect(queries[0]!.sentMessages).toEqual([]);
  });
});
