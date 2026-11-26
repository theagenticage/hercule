/**
 * Tests the reader of `agy`'s session files against a real temporary Harness
 * Home: the recorded files of `agy` 1.5.15 (fixtures/session-files) copied
 * into it, or files a test writes in the same layout.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, cpSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { cleanupHomes, createScratchHome } from "../testing";
import { APP_DATA_DIR } from "./harness-home";
import { openSessionFiles } from "./session-files";
import type { SessionFileObservation, SessionFiles } from "./session-files";

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

const open = (home: string, conversationId: string, skipExisting = false): Promise<SessionFiles> =>
  Effect.runPromise(openSessionFiles({ home, conversationId, skipExisting }));
const read = (files: SessionFiles) => Effect.runPromise(files.read);

/** Describes each observation as one short string, to compare whole reads. */
const describeAll = (observations: ReadonlyArray<SessionFileObservation>): ReadonlyArray<string> =>
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

/** Writes the message in which `parent` started `child`. */
const writeLaunchMessage = (home: string, parent: string, child: string, callId: string): void => {
  write(
    join(buildConversationFolder(home, child), "messages", `${randomUUID()}.json`),
    JSON.stringify({
      sender: parent,
      sourceMetadata: {
        tool: {
          stepIndex: 7,
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

  it("never returns the thinking signature of the launch message", async () => {
    const files = await open(createHomeFromFixture("subagent-full"), FULL_ROOT);

    expect(JSON.stringify(await read(files))).not.toContain("thinkingSignature");
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
    write(transcriptOf(home, root), line(0));
    registerChild(home, root, child);
    write(transcriptOf(home, child), line(0));
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
    write(transcriptOf(home, root), line(0));
    registerChild(home, root, child);
    write(transcriptOf(home, child), line(0));
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

  it("links a child without the launch fields when its launch message never comes", async () => {
    const home = createScratchHome("session-files");
    const root = randomUUID();
    const child = randomUUID();
    write(transcriptOf(home, root), line(0));
    registerChild(home, root, child);
    write(transcriptOf(home, child), line(0));
    // Not a launch: the file that lists read messages, and a message from a task.
    write(join(buildConversationFolder(home, child), "messages", "read.json"), "{}");
    write(
      join(buildConversationFolder(home, child), "messages", `${randomUUID()}.json`),
      JSON.stringify({ sender: `${root}/task-2`, content: "finished" }),
    );
    const files = await open(home, root);
    await read(files);

    const observations = await read(files);

    expect(describeAll(observations)).toEqual([
      `subagent ${child.slice(0, 4)}`,
      `step ${child.slice(0, 4)} 0`,
    ]);
    expect(observations[0]).toEqual({
      kind: "subagent",
      link: { conversationId: child, parentConversationId: root, role: "Helper", typeName: "self" },
    });
  });

  it("retries a child whose folder is not there yet, and announces it before its first step", async () => {
    const home = createScratchHome("session-files");
    const root = randomUUID();
    const child = randomUUID();
    write(transcriptOf(home, root), line(0));
    registerChild(home, root, child);
    const files = await open(home, root);

    expect(describeAll(await read(files))).toEqual([`step ${root.slice(0, 4)} 0`]);

    writeLaunchMessage(home, root, child, "call_1");
    expect(describeAll(await read(files))).toEqual([`subagent ${child.slice(0, 4)}`]);

    write(transcriptOf(home, child), line(0));
    expect(describeAll(await read(files))).toEqual([`step ${child.slice(0, 4)} 0`]);
  });

  it("finds a grandchild through its parent, and links it to its parent", async () => {
    const home = createScratchHome("session-files");
    const root = randomUUID();
    const child = randomUUID();
    const grandchild = randomUUID();
    write(transcriptOf(home, root), line(0));
    registerChild(home, root, child);
    write(transcriptOf(home, child), line(0));
    writeLaunchMessage(home, root, child, "call_1");
    registerChild(home, child, grandchild);
    write(transcriptOf(home, grandchild), line(0));
    writeLaunchMessage(home, child, grandchild, "call_2");

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

  it("reports the subagents past the bound once each, and keeps reading the others", async () => {
    const home = createScratchHome("session-files");
    const root = randomUUID();
    write(transcriptOf(home, root), line(0));
    const children = Array.from({ length: 66 }, () => randomUUID()).sort();
    for (const child of children) registerChild(home, root, child);
    const files = await open(home, root);

    const first = await read(files);

    expect(first.filter((o) => o.kind === "unreadable").map((o) => o.conversationId)).toEqual(
      children.slice(64),
    );
    expect(first.filter((o) => o.kind === "step")).toHaveLength(1);
    expect(await read(files)).toEqual([]);
  });
});
