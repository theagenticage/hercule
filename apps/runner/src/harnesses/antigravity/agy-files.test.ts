/**
 * Tests the reader of `agy`'s session files against a real temporary Harness
 * Home: the recorded files of `agy` 1.5.15 (fixtures/session-files) copied
 * into it, or files a test writes in the same layout.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, cpSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";
import { cleanupHomes, createScratchHome } from "../testing";
import { APP_DATA_DIR } from "./harness-home";
import { openAgyFiles, readRootConversationFact, readStepErrorText } from "./agy-files";
import type { AgyStep } from "./agy-files";
import type { AgyFileObservation, AgyFiles } from "./agy-files";

afterEach(() => {
  cleanupHomes();
});

const FIXTURES = join(import.meta.dirname, "fixtures", "session-files");
const FULL_ROOT = "86a5c11a-cc0d-4231-b6a7-4df5e51875e0";
const FULL_CHILD = "e4553827-0073-42e6-bc63-8e9619a7d435";

/** Returns a home that holds the `brain` folder of the recorded scenario `scenario`. */
const createHomeFromFixture = (scenario: string): string => {
  const home = createScratchHome("session-files");
  cpSync(join(FIXTURES, scenario, "brain"), join(home, APP_DATA_DIR, "brain"), { recursive: true });
  return home;
};

const buildConversationFolder = (home: string, id: string): string =>
  join(home, APP_DATA_DIR, "brain", id, ".system_generated");
const transcriptOf = (home: string, id: string): string =>
  join(buildConversationFolder(home, id), "logs", "transcript.jsonl");

const write = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/** Returns one transcript line, with the newline. */
const line = (index: number, extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ step_index: index, type: "GENERIC", status: "DONE", ...extra })}\n`;

/** Returns a transcript line of a step that calls the launch tool `count` times. */
const launchLine = (index: number, count = 1): string =>
  line(index, {
    tool_calls: Array.from({ length: count }, () => ({ name: "invoke_subagent", args: {} })),
  });

/**
 * Reads four times on a `TestClock`, moving it by `advances[i]` milliseconds
 * before read `i`. Returns the second read as `early`, the third as `late`
 * and the fourth as `after`; the first read finds the child's first step.
 */
const readOnTestClock = (files: AgyFiles, advances: ReadonlyArray<number>) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const results: Array<ReadonlyArray<AgyFileObservation>> = [];
        for (const advance of advances) {
          yield* TestClock.adjust(Duration.millis(advance));
          results.push((yield* files.read).observations);
        }
        return { early: results[1]!, late: results[2]!, after: results[3]! };
      }),
      TestClock.layer(),
    ),
  );

const open = (home: string, conversationId: string, skipExisting = false): Promise<AgyFiles> =>
  Effect.runPromise(openAgyFiles({ home, conversationId, skipExisting }));
const read = async (files: AgyFiles) => (await Effect.runPromise(files.read)).observations;

/** Describes each observation as one short string, to compare whole reads. */
const describeAll = (observations: ReadonlyArray<AgyFileObservation>): ReadonlyArray<string> =>
  observations.map((o) => {
    if (o.kind === "step") return `step ${o.conversationId.slice(0, 4)} ${String(o.step.index)}`;
    if (o.kind === "subagent") return `subagent ${o.link.conversationId.slice(0, 4)}`;
    return `unreadable ${o.conversationId.slice(0, 4)}`;
  });

/** Registers a child below `parent`, the way `agy` does. */
const registerChild = (home: string, parent: string, child: string): void => {
  write(
    join(buildConversationFolder(home, parent), "subagents", `${child}.json`),
    JSON.stringify({
      conversationId: child,
      subagentDescriptor: { typeName: "self", role: "Helper" },
      state: "SUBAGENT_STATE_ALIVE",
    }),
  );
};

/** Writes the message in which `parent` started `child`, naming `stepIndex` as the parent's step that holds the call's result. */
const writeLaunchMessage = (
  home: string,
  parent: string,
  child: string,
  callId: string,
  stepIndex = 7,
): void => {
  write(
    join(buildConversationFolder(home, child), "messages", `${randomUUID()}.json`),
    JSON.stringify({
      sender: parent,
      sourceMetadata: {
        tool: {
          stepIndex,
          toolCall: {
            id: callId,
            name: "invoke_subagent",
            argumentsJson: JSON.stringify({ Prompt: "do it", Role: "Helper", TypeName: "self" }),
          },
        },
      },
    }),
  );
};

describe("a recorded conversation with a subagent", () => {
  it("returns the steps of both conversations, and the child linked to the parent's tool call before its steps", async () => {
    const files = await open(createHomeFromFixture("subagent-full"), FULL_ROOT);

    const observations = await read(files);

    expect(describeAll(observations)).toEqual([
      ...[0, 1, 2, 3, 4, 5].map((i) => `step 86a5 ${String(i)}`),
      "subagent e455",
      ...[0, 1, 2, 3, 4, 5, 6].map((i) => `step e455 ${String(i)}`),
    ]);
    expect(observations.find((o) => o.kind === "subagent")).toEqual({
      kind: "subagent",
      link: {
        conversationId: FULL_CHILD,
        parentConversationId: FULL_ROOT,
        launchToolCallId: "call_11946467374736309831",
        launchStepIndex: 2,
        role: "File Writer",
        typeName: "self",
        brief:
          "Run the shell command `echo SUBMARK > sub.txt` in the workspace `/var/tmp/hercule-1283-work/subagent-full`, and then report back to me once it has completed.",
      },
    });
    expect(await read(files)).toEqual([]);
  });

  it("decodes the model, the usage and the arguments of a tool call", async () => {
    const files = await open(createHomeFromFixture("subagent-full"), FULL_ROOT);

    const steps = (await read(files)).flatMap((o) => (o.kind === "step" ? [o.step] : []));

    expect(steps[1]).toMatchObject({
      index: 1,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      model: "gemini-4-neon-high",
      usage: { inputTokens: 2229, cacheReadTokens: 6626, outputTokens: 424 },
      toolCalls: [{ name: "invoke_subagent", args: { Role: "File Writer", TypeName: "self" } }],
    });
    expect(steps[0]?.usage).toBeUndefined();
  });

  it("gives no usage to a step with some of the three counts missing", async () => {
    const home = createScratchHome("session-files");
    const id = randomUUID();
    write(transcriptOf(home, id), line(0, { input_tokens: 5, output_tokens: 7 }));

    const [observation] = await read(await open(home, id));

    expect(observation).toMatchObject({ kind: "step", step: { index: 0 } });
    expect(observation).not.toHaveProperty("step.usage");
  });

  it.each([
    ["missing", {}],
    ["negative", { input_tokens: -1, cache_read_tokens: 0, output_tokens: 1 }],
    ["fractional", { input_tokens: 1.5, cache_read_tokens: 0, output_tokens: 1 }],
    ["text", { input_tokens: "5", cache_read_tokens: 0, output_tokens: 1 }],
    ["null", { input_tokens: null, cache_read_tokens: 0, output_tokens: 1 }],
  ])(
    "flags a planner response whose token counts are %s as having invalid usage, and keeps the line",
    async (_name, counts) => {
      const home = createScratchHome("session-files");
      const id = randomUUID();
      write(transcriptOf(home, id), line(0, { type: "PLANNER_RESPONSE", ...counts }));

      const [observation] = await read(await open(home, id));

      expect(observation).toMatchObject({ kind: "step", step: { hasInvalidUsage: true } });
      expect(observation).not.toHaveProperty("step.usage");
    },
  );

  it("does not flag a planner response with valid counts, nor a step of another type without counts", async () => {
    const home = createScratchHome("session-files");
    const id = randomUUID();
    write(
      transcriptOf(home, id),
      line(0, {
        type: "PLANNER_RESPONSE",
        input_tokens: 0,
        cache_read_tokens: 0,
        output_tokens: 3,
      }) + line(1),
    );

    const steps = (await read(await open(home, id))).flatMap((o) =>
      o.kind === "step" ? [o.step] : [],
    );

    expect(steps[0]).toMatchObject({
      usage: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 3 },
    });
    expect(steps[0]).not.toHaveProperty("hasInvalidUsage");
    expect(steps[1]).not.toHaveProperty("hasInvalidUsage");
  });

  it("never returns the thinking signature of the launch message", async () => {
    const files = await open(createHomeFromFixture("subagent-full"), FULL_ROOT);

    expect(JSON.stringify(await read(files))).not.toContain("thinkingSignature");
  });
});

describe("readStepErrorText", () => {
  const build = (fields: Partial<AgyStep>): AgyStep => ({
    index: 0,
    type: "ERROR_MESSAGE",
    toolCalls: [],
    ...fields,
  });

  it.each([
    ["the error when both are set", { error: "boom", content: "text" }, "boom"],
    ["the content when the error is empty", { error: "", content: "text" }, "text"],
    ["the content when there is no error", { content: "text" }, "text"],
    ["nothing when both are empty", { error: "", content: "" }, undefined],
    ["nothing when both are missing", {}, undefined],
  ])("returns %s", (_name, fields, expected) => {
    expect(readStepErrorText(build(fields))).toBe(expected);
  });
});

describe("readRootConversationFact", () => {
  const build = (fields: Partial<AgyStep>): AgyStep => ({
    index: 0,
    type: "GENERIC",
    toolCalls: [],
    ...fields,
  });

  it.each([
    ["an input for a USER_INPUT step", { type: "USER_INPUT", content: "go" }, { kind: "input" }],
    [
      "a provider error with the error text for an ERROR_MESSAGE step",
      { type: "ERROR_MESSAGE", error: "503 no capacity" },
      { kind: "provider-error", words: "503 no capacity" },
    ],
    ["nothing for an ERROR_MESSAGE step without text", { type: "ERROR_MESSAGE" }, undefined],
    ["nothing for any other step", { type: "GENERIC", content: "x" }, undefined],
  ])("returns %s", (_name, fields, expected) => {
    expect(readRootConversationFact(build(fields))).toEqual(expected);
  });
});

describe("a conversation that grows", () => {
  it("returns only the new steps at each call, and holds a line until it is complete", async () => {
    const home = createScratchHome("session-files");
    const id = randomUUID();
    write(transcriptOf(home, id), line(0) + line(1));
    const files = await open(home, id);

    expect(describeAll(await read(files))).toEqual([
      `step ${id.slice(0, 4)} 0`,
      `step ${id.slice(0, 4)} 1`,
    ]);
    expect(await read(files)).toEqual([]);

    const torn = Buffer.from(line(2, { content: "héllo" }));
    const cut = torn.length - 6;
    appendFileSync(transcriptOf(home, id), torn.subarray(0, cut));
    expect(await read(files)).toEqual([]);

    appendFileSync(transcriptOf(home, id), torn.subarray(cut));
    appendFileSync(transcriptOf(home, id), line(3));
    expect(await read(files)).toMatchObject([
      { kind: "step", step: { index: 2, content: "héllo" } },
      { kind: "step", step: { index: 3 } },
    ]);
  });

  it("is not an error when the files are not there yet", async () => {
    const home = createScratchHome("session-files");
    const id = randomUUID();
    const files = await open(home, id);

    expect(await read(files)).toEqual([]);

    write(transcriptOf(home, id), line(0));
    expect(describeAll(await read(files))).toEqual([`step ${id.slice(0, 4)} 0`]);
  });

  it("returns a transcript bigger than one call may read over several calls, in order", async () => {
    const home = createScratchHome("session-files");
    const id = randomUUID();
    const total = 100;
    // 100 steps of 100 KiB are about 10 MiB, above what one call reads.
    write(transcriptOf(home, id), "");
    for (let i = 0; i < total; i += 1) {
      appendFileSync(transcriptOf(home, id), line(i, { content: "x".repeat(100 * 1024) }));
    }
    const files = await open(home, id);

    const first = await read(files);
    const indexes = first.map((o) => (o.kind === "step" ? o.step.index : -1));
    let calls = 1;
    while (indexes.length < total && calls < 10) {
      for (const o of await read(files)) indexes.push(o.kind === "step" ? o.step.index : -1);
      calls += 1;
    }

    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(total);
    expect(indexes).toEqual(Array.from({ length: total }, (_, i) => i));
  });
});

describe("skipExisting", () => {
  it("starts every transcript at its end, and announces an existing child only when it has a new step", async () => {
    const home = createHomeFromFixture("subagent-full");
    const files = await open(home, FULL_ROOT, true);

    expect(await read(files)).toEqual([]);

    appendFileSync(transcriptOf(home, FULL_ROOT), line(6, { content: "next turn" }));
    expect(describeAll(await read(files))).toEqual(["step 86a5 6"]);

    appendFileSync(transcriptOf(home, FULL_CHILD), line(7, { content: "more" }));
    const observations = await read(files);
    expect(describeAll(observations)).toEqual(["subagent e455", "step e455 7"]);
    expect(observations[0]).toMatchObject({
      link: { launchToolCallId: "call_11946467374736309831", role: "File Writer" },
    });
  });

  it("reads a transcript that did not exist yet from its start", async () => {
    const home = createScratchHome("session-files");
    const id = randomUUID();
    const files = await open(home, id, true);

    write(transcriptOf(home, id), line(0));

    expect(describeAll(await read(files))).toEqual([`step ${id.slice(0, 4)} 0`]);
  });
});

describe("a file that is not as agy writes it", () => {
  const createRootAndChild = (): { home: string; root: string; child: string } => {
    const home = createScratchHome("session-files");
    const root = randomUUID();
    const child = randomUUID();
    write(transcriptOf(home, root), launchLine(0));
    registerChild(home, root, child);
    write(transcriptOf(home, child), launchLine(0));
    writeLaunchMessage(home, root, child, "call_1");
    return { home, root, child };
  };

  it.each([
    ["a line that is not JSON", "this is not json\n"],
    ["a line that is not an object", "[1,2]\n"],
    ["a step without a step_index", `${JSON.stringify({ type: "GENERIC" })}\n`],
    ["a step without a type", `${JSON.stringify({ step_index: 1 })}\n`],
  ])(
    "reports %s once, keeps the lines before it, and keeps reading the other conversations",
    async (_name, bad) => {
      const { home, root, child } = createRootAndChild();
      const files = await open(home, root);
      await read(files);

      appendFileSync(transcriptOf(home, root), line(1) + bad + line(2));
      appendFileSync(transcriptOf(home, child), line(1));
      expect(await read(files)).toMatchObject([
        { kind: "step", conversationId: root, step: { index: 1 } },
        { kind: "unreadable", conversationId: root },
        { kind: "step", conversationId: child, step: { index: 1 } },
      ]);

      appendFileSync(transcriptOf(home, root), line(3));
      appendFileSync(transcriptOf(home, child), line(2));
      expect(describeAll(await read(files))).toEqual([`step ${child.slice(0, 4)} 2`]);
    },
  );

  it("reports a transcript that was replaced by another file", async () => {
    const { home, root } = createRootAndChild();
    const files = await open(home, root);
    await read(files);

    // The new file is made before the old one goes, so it cannot get the old inode.
    const replacement = `${transcriptOf(home, root)}.new`;
    write(replacement, line(0) + line(1) + line(2));
    renameSync(replacement, transcriptOf(home, root));

    expect(describeAll(await read(files))).toEqual([`unreadable ${root.slice(0, 4)}`]);
    expect(await read(files)).toEqual([]);
  });

  it("reports a transcript that got shorter", async () => {
    const { home, root } = createRootAndChild();
    const files = await open(home, root);
    appendFileSync(transcriptOf(home, root), line(1));
    await read(files);

    writeFileSync(transcriptOf(home, root), line(0));

    expect(describeAll(await read(files))).toEqual([`unreadable ${root.slice(0, 4)}`]);
  });

  it("reports a line longer than the bound", async () => {
    const { home, root } = createRootAndChild();
    write(transcriptOf(home, root), line(0, { content: "x".repeat(5 * 1024 * 1024) }));

    expect(describeAll(await read(await open(home, root)))).toEqual([
      `unreadable ${root.slice(0, 4)}`,
    ]);
  });

  it("refuses a transcript that is a link", async () => {
    const home = createScratchHome("session-files");
    const id = randomUUID();
    const elsewhere = join(createScratchHome("session-files-elsewhere"), "t.jsonl");
    write(elsewhere, line(0));
    mkdirSync(dirname(transcriptOf(home, id)), { recursive: true });
    symlinkSync(elsewhere, transcriptOf(home, id));

    expect(describeAll(await read(await open(home, id)))).toEqual([`unreadable ${id.slice(0, 4)}`]);
  });

  it("refuses a transcript below a folder that is a link", async () => {
    const home = createScratchHome("session-files");
    const id = randomUUID();
    const elsewhere = createScratchHome("session-files-elsewhere");
    write(join(elsewhere, "transcript.jsonl"), line(0));
    mkdirSync(buildConversationFolder(home, id), { recursive: true });
    symlinkSync(elsewhere, join(buildConversationFolder(home, id), "logs"));

    expect(describeAll(await read(await open(home, id)))).toEqual([`unreadable ${id.slice(0, 4)}`]);
  });

  it("refuses an app data folder that is a link", async () => {
    const home = createScratchHome("session-files");
    const id = randomUUID();
    const elsewhere = createScratchHome("session-files-elsewhere");
    write(transcriptOf(elsewhere, id), line(0));
    symlinkSync(join(elsewhere, APP_DATA_DIR), join(home, APP_DATA_DIR));

    expect(describeAll(await read(await open(home, id)))).toEqual([`unreadable ${id.slice(0, 4)}`]);
  });
});

describe("subagents", () => {
  it("holds the steps of a child whose launch message is late, and links it fully when the message comes", async () => {
    const home = createScratchHome("session-files");
    const root = randomUUID();
    const child = randomUUID();
    write(transcriptOf(home, root), launchLine(0));
    registerChild(home, root, child);
    write(transcriptOf(home, child), launchLine(0));
    const files = await open(home, root);

    expect(describeAll(await read(files))).toEqual([`step ${root.slice(0, 4)} 0`]);

    writeLaunchMessage(home, root, child, "call_late");
    const observations = await read(files);
    expect(describeAll(observations)).toEqual([
      `subagent ${child.slice(0, 4)}`,
      `step ${child.slice(0, 4)} 0`,
    ]);
    expect(observations[0]).toMatchObject({
      link: { launchToolCallId: "call_late", launchStepIndex: 7 },
    });
  });

  it("reports a child that has had steps for 2 seconds without a launch message once, and never links it", async () => {
    const home = createScratchHome("session-files");
    const root = randomUUID();
    const child = randomUUID();
    write(transcriptOf(home, root), launchLine(0));
    registerChild(home, root, child);
    write(transcriptOf(home, child), launchLine(0));
    // Not a launch: the file that lists read messages, and a message from a task.
    write(join(buildConversationFolder(home, child), "messages", "read.json"), "{}");
    write(
      join(buildConversationFolder(home, child), "messages", `${randomUUID()}.json`),
      JSON.stringify({ sender: `${root}/task-2`, content: "finished" }),
    );
    const files = await open(home, root);

    const { early, late, after } = await readOnTestClock(files, [0, 1900, 200, 0]);

    expect(early).toEqual([]);
    expect(late).toEqual([
      {
        kind: "unreadable",
        conversationId: child,
        reason: "agy wrote no launch message for this subagent",
      },
    ]);
    expect(after).toEqual([]);
  });

  it("does not link a child from a launch message sent by another conversation or for another tool", async () => {
    const home = createScratchHome("session-files");
    const root = randomUUID();
    const child = randomUUID();
    write(transcriptOf(home, root), launchLine(0));
    registerChild(home, root, child);
    write(transcriptOf(home, child), launchLine(0));
    const toolMessage = (sender: string, name: string): string =>
      JSON.stringify({
        sender,
        sourceMetadata: { tool: { stepIndex: 1, toolCall: { id: "call_x", name } } },
      });
    write(
      join(buildConversationFolder(home, child), "messages", `${randomUUID()}.json`),
      toolMessage(randomUUID(), "invoke_subagent"),
    );
    write(
      join(buildConversationFolder(home, child), "messages", `${randomUUID()}.json`),
      toolMessage(root, "swarm"),
    );
    const files = await open(home, root);

    const { late } = await readOnTestClock(files, [0, 0, 2100, 0]);

    expect(describeAll(late)).toEqual([`unreadable ${child.slice(0, 4)}`]);
  });

  it("announces a grandchild only after its parent, and holds its steps until then", async () => {
    const home = createScratchHome("session-files");
    const root = randomUUID();
    const child = randomUUID();
    const grandchild = randomUUID();
    write(transcriptOf(home, root), launchLine(0));
    registerChild(home, root, child);
    write(transcriptOf(home, child), launchLine(0));
    registerChild(home, child, grandchild);
    write(transcriptOf(home, grandchild), line(0));
    writeLaunchMessage(home, child, grandchild, "call_2", 0);
    const files = await open(home, root);

    expect(describeAll(await read(files))).toEqual([`step ${root.slice(0, 4)} 0`]);

    writeLaunchMessage(home, root, child, "call_1");
    expect(describeAll(await read(files))).toEqual([
      `subagent ${child.slice(0, 4)}`,
      `step ${child.slice(0, 4)} 0`,
      `subagent ${grandchild.slice(0, 4)}`,
      `step ${grandchild.slice(0, 4)} 0`,
    ]);
  });

  it("retries a child whose folder is not there yet, and announces it before its first step", async () => {
    const home = createScratchHome("session-files");
    const root = randomUUID();
    const child = randomUUID();
    write(transcriptOf(home, root), launchLine(0));
    registerChild(home, root, child);
    const files = await open(home, root);

    expect(describeAll(await read(files))).toEqual([`step ${root.slice(0, 4)} 0`]);

    writeLaunchMessage(home, root, child, "call_1");
    expect(describeAll(await read(files))).toEqual([`subagent ${child.slice(0, 4)}`]);

    write(transcriptOf(home, child), launchLine(0));
    expect(describeAll(await read(files))).toEqual([`step ${child.slice(0, 4)} 0`]);
  });

  it("finds a grandchild through its parent, and links it to its parent", async () => {
    const home = createScratchHome("session-files");
    const root = randomUUID();
    const child = randomUUID();
    const grandchild = randomUUID();
    write(transcriptOf(home, root), launchLine(0));
    registerChild(home, root, child);
    write(transcriptOf(home, child), launchLine(0));
    writeLaunchMessage(home, root, child, "call_1");
    registerChild(home, child, grandchild);
    write(transcriptOf(home, grandchild), line(0));
    writeLaunchMessage(home, child, grandchild, "call_2", 0);

    const observations = await read(await open(home, root));

    expect(describeAll(observations)).toEqual([
      `step ${root.slice(0, 4)} 0`,
      `subagent ${child.slice(0, 4)}`,
      `step ${child.slice(0, 4)} 0`,
      `subagent ${grandchild.slice(0, 4)}`,
      `step ${grandchild.slice(0, 4)} 0`,
    ]);
    expect(observations[3]).toMatchObject({
      link: { parentConversationId: child, launchToolCallId: "call_2" },
    });
  });

  it("reports the subagents past the bound once each when they produce a step, and keeps reading the others", async () => {
    const home = createScratchHome("session-files");
    const root = randomUUID();
    write(transcriptOf(home, root), launchLine(0, 66));
    const children = Array.from({ length: 66 }, () => randomUUID()).sort();
    for (const child of children) {
      registerChild(home, root, child);
      write(transcriptOf(home, child), line(0));
      writeLaunchMessage(home, root, child, `call_${child}`);
    }
    const files = await open(home, root);

    const first = await read(files);

    expect(first.filter((o) => o.kind === "unreadable").map((o) => o.conversationId)).toEqual(
      children.slice(64),
    );
    expect(first.filter((o) => o.kind === "subagent")).toHaveLength(64);
    expect(first.filter((o) => o.kind === "step")).toHaveLength(65);
    expect(await read(files)).toEqual([]);
  });

  it("does not count subagents known at a resume that have not grown toward the bound", async () => {
    const home = createScratchHome("session-files");
    const root = randomUUID();
    write(transcriptOf(home, root), launchLine(0, 64));
    for (let i = 0; i < 64; i += 1) {
      const old = randomUUID();
      registerChild(home, root, old);
      write(transcriptOf(home, old), line(0));
      writeLaunchMessage(home, root, old, `call_${old}`);
    }
    const files = await open(home, root, true);
    expect(await read(files)).toEqual([]);

    const fresh = randomUUID();
    appendFileSync(transcriptOf(home, root), launchLine(1));
    registerChild(home, root, fresh);
    write(transcriptOf(home, fresh), line(0));
    writeLaunchMessage(home, root, fresh, "call_fresh");

    expect(describeAll(await read(files))).toEqual([
      `step ${root.slice(0, 4)} 1`,
      `subagent ${fresh.slice(0, 4)}`,
      `step ${fresh.slice(0, 4)} 0`,
    ]);
  });
});

describe("listing the subagents folder", () => {
  it("lists the session's own folder on every call, so a child registered without a launch call is found", async () => {
    const home = createScratchHome("session-files");
    const root = randomUUID();
    const child = randomUUID();
    write(transcriptOf(home, root), line(0));
    const files = await open(home, root);
    expect(describeAll(await read(files))).toEqual([`step ${root.slice(0, 4)} 0`]);

    // No step of the root called the launch tool, as when `agy` registers a child for `/swarm`.
    registerChild(home, root, child);
    write(transcriptOf(home, child), line(0));
    writeLaunchMessage(home, root, child, "call_1");

    expect(describeAll(await read(files))).toEqual([
      `subagent ${child.slice(0, 4)}`,
      `step ${child.slice(0, 4)} 0`,
    ]);
  });

  it("reports a child registered without a launch call that never gets a launch message", async () => {
    const home = createScratchHome("session-files");
    const root = randomUUID();
    const child = randomUUID();
    write(transcriptOf(home, root), line(0));
    registerChild(home, root, child);
    write(transcriptOf(home, child), line(0));
    const files = await open(home, root);

    const { late } = await readOnTestClock(files, [0, 0, 2100, 0]);

    expect(describeAll(late)).toEqual([`unreadable ${child.slice(0, 4)}`]);
  });

  it("lists a child's folder only after a step of it called the launch tool, and until as many new subagents appeared as calls were seen", async () => {
    const home = createScratchHome("session-files");
    const root = randomUUID();
    const child = randomUUID();
    const [first, second, third] = [randomUUID(), randomUUID(), randomUUID()];
    write(transcriptOf(home, root), line(0));
    registerChild(home, root, child);
    write(transcriptOf(home, child), line(0));
    writeLaunchMessage(home, root, child, "call_0");
    registerChild(home, child, first);
    write(transcriptOf(home, first), line(0));
    writeLaunchMessage(home, child, first, "call_1", 0);
    const files = await open(home, root);

    // A subagent registered below the child with no launch call seen is not looked for.
    expect(describeAll(await read(files))).toEqual([
      `step ${root.slice(0, 4)} 0`,
      `subagent ${child.slice(0, 4)}`,
      `step ${child.slice(0, 4)} 0`,
    ]);

    appendFileSync(transcriptOf(home, child), launchLine(1, 2));
    expect(describeAll(await read(files))).toEqual([
      `step ${child.slice(0, 4)} 1`,
      `subagent ${first.slice(0, 4)}`,
      `step ${first.slice(0, 4)} 0`,
    ]);

    // One of the two calls has its subagent; the folder is listed again until the second shows up.
    registerChild(home, child, second);
    write(transcriptOf(home, second), line(0));
    writeLaunchMessage(home, child, second, "call_2", 0);
    expect(describeAll(await read(files))).toEqual([
      `subagent ${second.slice(0, 4)}`,
      `step ${second.slice(0, 4)} 0`,
    ]);

    // Both calls are matched: a third registration is not looked for.
    registerChild(home, child, third);
    write(transcriptOf(home, third), line(0));
    writeLaunchMessage(home, child, third, "call_3", 0);
    expect(await read(files)).toEqual([]);
  });
});

describe("waiting for a link", () => {
  it("says it awaits a link while a child's steps wait for its launch message, and not after the child is announced or reported", async () => {
    const home = createScratchHome("session-files");
    const root = randomUUID();
    const child = randomUUID();
    write(transcriptOf(home, root), launchLine(0));
    registerChild(home, root, child);
    write(transcriptOf(home, child), line(0));
    const files = await open(home, root);

    expect((await Effect.runPromise(files.read)).isAwaitingLink).toBe(true);

    writeLaunchMessage(home, root, child, "call_1");
    expect((await Effect.runPromise(files.read)).isAwaitingLink).toBe(false);
  });

  it("stops awaiting once the wait ran out and the child was reported unreadable", async () => {
    const home = createScratchHome("session-files");
    const root = randomUUID();
    const child = randomUUID();
    write(transcriptOf(home, root), launchLine(0));
    registerChild(home, root, child);
    write(transcriptOf(home, child), line(0));
    const files = await open(home, root);

    const flags = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const results: Array<boolean> = [];
          for (const advance of [0, 1900, 200]) {
            yield* TestClock.adjust(Duration.millis(advance));
            results.push((yield* files.read).isAwaitingLink);
          }
          return results;
        }),
        TestClock.layer(),
      ),
    );

    expect(flags).toEqual([true, true, false]);
  });

  it("does not await anything for a conversation with no children", async () => {
    const home = createScratchHome("session-files");
    const root = randomUUID();
    write(transcriptOf(home, root), line(0));

    expect((await Effect.runPromise((await open(home, root)).read)).isAwaitingLink).toBe(false);
  });

  it("holds a grandchild until its parent's transcript was read up to the launch step, then names that step", async () => {
    const home = createScratchHome("session-files");
    const root = randomUUID();
    const child = randomUUID();
    const grandchild = randomUUID();
    write(transcriptOf(home, root), launchLine(0));
    registerChild(home, root, child);
    write(transcriptOf(home, child), launchLine(0));
    writeLaunchMessage(home, root, child, "call_1");
    registerChild(home, child, grandchild);
    write(transcriptOf(home, grandchild), line(0));
    // The launch call's result is the child's step 3, which is not written yet.
    writeLaunchMessage(home, child, grandchild, "call_2", 3);
    const files = await open(home, root);

    const early = await Effect.runPromise(files.read);
    expect(describeAll(early.observations)).toEqual([
      `step ${root.slice(0, 4)} 0`,
      `subagent ${child.slice(0, 4)}`,
      `step ${child.slice(0, 4)} 0`,
    ]);
    expect(early.isAwaitingLink).toBe(true);

    appendFileSync(transcriptOf(home, child), line(1) + line(3));
    const late = await Effect.runPromise(files.read);
    expect(describeAll(late.observations)).toEqual([
      `step ${child.slice(0, 4)} 1`,
      `step ${child.slice(0, 4)} 3`,
      `subagent ${grandchild.slice(0, 4)}`,
      `step ${grandchild.slice(0, 4)} 0`,
    ]);
    expect(late.observations[2]).toMatchObject({ link: { launchStepIndex: 3 } });
    expect(late.isAwaitingLink).toBe(false);
  });

  it("announces a grandchild without the launch step once the parent's transcript did not reach it within 2 seconds", async () => {
    const home = createScratchHome("session-files");
    const root = randomUUID();
    const child = randomUUID();
    const grandchild = randomUUID();
    write(transcriptOf(home, root), launchLine(0));
    registerChild(home, root, child);
    write(transcriptOf(home, child), launchLine(0));
    writeLaunchMessage(home, root, child, "call_1");
    registerChild(home, child, grandchild);
    write(transcriptOf(home, grandchild), line(0));
    writeLaunchMessage(home, child, grandchild, "call_2", 3);
    const files = await open(home, root);

    const { early, late } = await readOnTestClock(files, [0, 1900, 200, 0]);

    expect(describeAll(early)).toEqual([]);
    expect(describeAll(late)).toEqual([
      `subagent ${grandchild.slice(0, 4)}`,
      `step ${grandchild.slice(0, 4)} 0`,
    ]);
    expect(late[0]).toMatchObject({ link: { launchToolCallId: "call_2" } });
    expect(late[0]).not.toHaveProperty("link.launchStepIndex");
  });
});

describe("a transcript with a null optional field", () => {
  it("reads a field whose value is null as absent", async () => {
    const home = createScratchHome("session-files");
    const id = randomUUID();
    write(
      transcriptOf(home, id),
      line(0, { content: null, thinking: null, model: null, tool_calls: null, status: null }),
    );

    const [observation] = await read(await open(home, id));

    expect(observation).toEqual({
      kind: "step",
      conversationId: id,
      step: { index: 0, type: "GENERIC", toolCalls: [] },
    });
  });
});

describe("a line that is too long", () => {
  it("returns the complete lines before a too-long unfinished tail, then reports the transcript", async () => {
    const home = createScratchHome("session-files");
    const id = randomUUID();
    write(transcriptOf(home, id), line(0) + line(1) + "x".repeat(5 * 1024 * 1024));

    expect(describeAll(await read(await open(home, id)))).toEqual([
      `step ${id.slice(0, 4)} 0`,
      `step ${id.slice(0, 4)} 1`,
      `unreadable ${id.slice(0, 4)}`,
    ]);
  });
});
