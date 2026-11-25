/**
 * Tests for the fake harness, driven with raw JSON lines the way a harness
 * process is driven. They protect the rules an adapter's tests lean on: how
 * setup requests are matched, where a turn waits, which ids the replies carry,
 * and what an unknown request gets.
 */
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  readRecording,
  RECORDING_NAMES,
  startFakeHarness,
  type JsonRpcMessage,
  type RecordedMessage,
} from "./testing";

/** Writes the client's side of a conversation and collects what the fake sends back. */
const connect = (options: Parameters<typeof startFakeHarness>[0]) => {
  const harness = startFakeHarness(options);
  const sent: Array<JsonRpcMessage> = [];
  void (async () => {
    for await (const line of harness.stdout) sent.push(JSON.parse(line) as JsonRpcMessage);
  })();
  return {
    harness,
    sent,
    write: (message: Record<string, unknown>) => {
      harness.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    },
    /** Waits until the fake has put everything it is going to send on stdout. */
    settle: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  };
};

const request = (id: string | number, method: string): RecordedMessage => ({
  direction: "out",
  message: { jsonrpc: "2.0", id, method },
});
const notification = (
  direction: "in" | "out",
  method: string,
  params?: unknown,
): RecordedMessage => ({
  direction,
  message: { jsonrpc: "2.0", method, params },
});
const reply = (direction: "in" | "out", id: string | number, result: unknown): RecordedMessage => ({
  direction,
  message: { jsonrpc: "2.0", id, result },
});
const update = (text: string): RecordedMessage => notification("in", "session/update", { text });

describe("the setup part of a recording", () => {
  it("answers each request by its method, in any order, with the client's own id", async () => {
    const steer2 = readRecording("steer2");
    const { sent, write, settle } = connect({ recording: steer2 });

    write({ id: 7, method: "session/new", params: {} });
    write({ id: 8, method: "initialize", params: {} });
    await settle();

    expect(sent.map((message) => message.id)).toEqual([7, 8]);
    const newSessionReply = steer2.find(
      ({ direction, message }) => direction === "in" && message.id === 3,
    );
    expect(sent[0]!.result).toEqual(newSessionReply!.message.result);
    expect(sent[1]!.result).toMatchObject({ protocolVersion: 1 });
  });
});

describe("a turn", () => {
  it("waits at a approval request and at a cancel until the client sends the matching message", async () => {
    const { sent, write, settle } = connect({
      recording: [
        request(1, "session/prompt"),
        update("a"),
        {
          direction: "in",
          message: { jsonrpc: "2.0", id: "perm:1", method: "session/request_permission" },
        },
        reply("out", "perm:1", { outcome: "selected" }),
        update("b"),
        notification("out", "session/cancel"),
        update("c"),
        reply("in", 1, { stopReason: "cancelled" }),
      ],
    });
    const methodsAndIds = () => sent.map((message) => message.method ?? `reply ${message.id}`);

    write({ id: 5, method: "session/prompt" });
    await settle();
    expect(methodsAndIds()).toEqual(["session/update", "session/request_permission"]);

    // A reply to some other request does not open the gate.
    write({ id: "perm:other", result: {} });
    await settle();
    expect(sent).toHaveLength(2);

    write({ id: "perm:1", result: { outcome: "selected" } });
    await settle();
    expect(methodsAndIds()).toEqual([
      "session/update",
      "session/request_permission",
      "session/update",
    ]);

    write({ method: "session/cancel" });
    await settle();
    expect(methodsAndIds().slice(3)).toEqual(["session/update", "reply 5"]);
  });

  it.each([
    {
      name: "a request does not open the gate of a notification",
      recording: [
        request(1, "session/prompt"),
        notification("out", "session/cancel"),
        update("after the cancel"),
      ],
      wrong: { id: 6, method: "session/cancel" },
      right: { method: "session/cancel" },
    },
    {
      name: "a notification does not open the gate of a request",
      recording: [
        request(1, "session/prompt"),
        request(2, "session/prompt"),
        update("after the second prompt"),
      ],
      wrong: { method: "session/prompt" },
      right: { id: 6, method: "session/prompt" },
    },
  ])("keeps waiting when $name with the same method", async ({ recording, wrong, right }) => {
    const { sent, write, settle } = connect({ recording });
    write({ id: 5, method: "session/prompt" });
    await settle();

    write(wrong);
    await settle();
    expect(sent.filter((message) => message.method === "session/update")).toEqual([]);

    write(right);
    await settle();
    expect(sent.filter((message) => message.method === "session/update")).toHaveLength(1);
  });

  it("sends a reply with the id of the client's request, also when it arrives after a second prompt", async () => {
    const steer2 = readRecording("steer2");
    const sessionId = (
      steer2.find(({ message }) => message.method === "session/prompt")!.message.params as {
        sessionId: string;
      }
    ).sessionId;
    const { sent, write, settle } = connect({ recording: steer2 });
    for (const [id, method] of [
      [1, "initialize"],
      [2, "authenticate"],
      [3, "session/new"],
      [4, "session/set_mode"],
    ] as const) {
      write({ id, method, params: {} });
    }
    await settle();
    const setupCount = sent.length;

    write({ id: 50, method: "session/prompt", params: { sessionId } });
    await settle();
    const beforeSecondPrompt = sent.slice(setupCount);
    expect(beforeSecondPrompt.every((message) => message.method === "session/update")).toBe(true);
    expect(beforeSecondPrompt.at(-1)!.params).toMatchObject({
      update: { sessionUpdate: "tool_call" },
    });

    write({ id: 51, method: "session/prompt", params: { sessionId } });
    await settle();
    const afterSecondPrompt = sent.slice(setupCount + beforeSecondPrompt.length);
    expect(afterSecondPrompt[0]!.id).toBe(50);
    expect(afterSecondPrompt[0]!.result).toBeDefined();
    expect(afterSecondPrompt.length).toBeGreaterThan(1);
  });
});

describe("a request the recording does not answer", () => {
  it("is answered from replies when it has one, and with -32601 naming the method when it has none", async () => {
    const { harness, sent, write, settle } = connect({
      recording: [request(1, "initialize"), reply("in", 1, { protocolVersion: 1 })],
      replies: { "session/set_mode": {} },
    });

    write({ id: 10, method: "session/set_mode" });
    write({ id: 11, method: "session/close" });
    write({ method: "some/notification" });
    await settle();

    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({ jsonrpc: "2.0", id: 10, result: {} });
    expect(sent[1]!.id).toBe(11);
    expect(sent[1]!.error!.code).toBe(-32601);
    expect(sent[1]!.error!.message).toContain("session/close");
    expect(harness.received.map((message) => message.method)).toEqual([
      "session/set_mode",
      "session/close",
      "some/notification",
    ]);
  });
});

describe("the process", () => {
  it("ends stdout and reports exit code 0 for end and 143 for kill", async () => {
    const ended = startFakeHarness({ recording: [] });
    ended.sendLine("not json");
    ended.end();
    const lines: Array<string> = [];
    for await (const line of ended.stdout) lines.push(line);
    expect(lines).toEqual(["not json"]);
    expect(await ended.exited).toBe(0);

    const killed = startFakeHarness({ recording: [] });
    killed.kill();
    expect(await killed.exited).toBe(143);
  });
});

describe("the recordings", () => {
  it("are all listed in RECORDING_NAMES", () => {
    const onDisk = readdirSync(new URL("./recordings", import.meta.url))
      .filter((file) => file.endsWith(".jsonl"))
      .map((file) => file.replace(/\.jsonl$/, ""))
      .sort();
    expect([...RECORDING_NAMES].sort()).toEqual(onDisk);
  });
});
