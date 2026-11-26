/**
 * A fake harness for tests: it answers over the same pipes a real harness
 * process has, so an adapter's tests need no `agy` binary.
 *
 * The fake does not understand ACP. Its answers come from a recording of a
 * real run, from a script a test writes for a method, or from both. A
 * recording lists every message in the order it crossed the wire. Messages
 * marked "in" were sent by the harness to the client, and messages marked
 * "out" were sent by the client to the harness.
 */
import { readFileSync } from "node:fs";

/** The names of the recordings in `./recordings`, one file per recorded run. */
export const RECORDING_NAMES = [
  "ask-settings",
  "ask-shared",
  "background-command",
  "bad-model",
  "basic-allow",
  "cancel",
  "cancel-during-permission",
  "cancel-permission",
  "compact",
  "deny",
  "deny-cancelled-followup",
  "deny-followup",
  "deny2",
  "edit-shell",
  "failed-turn-network",
  "hk-disable-try",
  "hk-fakehome",
  "hk-gitroot",
  "hk-homecfg",
  "hk-parent",
  "hk-strict",
  "hk-subfolder",
  "hook-default-vartmp",
  "image-prompt",
  "interrupt-running",
  "mode-accept-edits",
  "mode-accept-edits-vartmp-ws",
  "mode-default",
  "mode-default-outside-parentdir",
  "mode-default-outside-tmp",
  "mode-default-outside-vartmp",
  "mode-default-url",
  "mode-default-vartmp-ws",
  "model-switch",
  "modes",
  "nonzero-exit",
  "plan-mode",
  "question",
  "question-elicit",
  "question-variants",
  "read-outside",
  "resume",
  "sandbox-accept-edits",
  "sandbox-default",
  "sandbox-full",
  "search-list-fetch-delete",
  "steer",
  "steer2",
  "stop-bg",
  "stop-cancel",
  "stop-fg",
  "strict-default",
  "strict-fakehome",
  "strict-wsfiles",
  "subagent",
  "subagent-approval2",
  "symlink-into-tmp",
  "t1-hooks",
  "t2-config-allow",
  "t2-config-allowall",
  "t2-config-deny",
  "t2-settings-allow",
  "t2-settings-allowall",
  "t2-settings-deny",
  "t2b-always",
  "t3-resume",
  "t4-plan",
  "t5-stopped",
  "t6-search-accept-edits-plain",
  "t6-search-accept-edits-strict",
  "t6-search-default-plain",
  "t6-search-default-strict",
  "t7-always-proceed",
  "t7-proceed-in-sandbox",
  "tmpdir-a-work-in-tmp",
  "tmpdir-b-work-in-tmpdir",
  "tmpdir-resume",
  "tmpdir2-link-into-tmpdir",
  "tmpdir2-other-vs-tmpdir",
  "todo",
  "two-requests",
  "websearch",
] as const;

export type RecordingName = (typeof RECORDING_NAMES)[number];

/**
 * One JSON-RPC 2.0 message as it crossed the wire. A request has `method` and
 * `id`, a notification has `method` only, and a reply has `id` and either
 * `result` or `error`.
 */
export interface JsonRpcMessage {
  readonly jsonrpc: "2.0";
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export interface RecordedMessage {
  /** "in" was sent by the harness to the client, "out" by the client to the harness. */
  readonly direction: "in" | "out";
  readonly message: JsonRpcMessage;
}

/** A request of the client that a script answers. */
export interface HarnessCall {
  readonly id: string | number;
  readonly params: unknown;
}

/**
 * Returns the lines the harness writes in answer to `call`, each a message or
 * the text of a line. It returns none for a call the harness never answers. It
 * may use `harness` to end or break the output, which takes effect after the
 * returned lines, and to read what the client wrote.
 */
export type HarnessScript = (
  call: HarnessCall,
  harness: FakeHarness,
) => ReadonlyArray<JsonRpcMessage | string>;

/** Returns a script that answers with `result`. */
export const answerWith =
  (result: unknown): HarnessScript =>
  ({ id }) => [{ jsonrpc: "2.0", id, result }];

/** A harness process the way the runner talks to it: lines in both directions, ended or killed. */
export interface FakeHarness {
  /**
   * Takes what the client writes. A message is handled once its line is
   * complete. The promise rejects after `failWrites`.
   */
  readonly write: (text: string) => Promise<void>;
  /** The harness's output, one whole line per item, without the newline. */
  readonly stdout: AsyncIterable<string>;
  /** Always empty. It ends when the harness does. */
  readonly stderr: AsyncIterable<string>;
  /** Closes the harness's input, which ends it with exit code 0. */
  readonly end: () => void;
  /** Stops the harness with exit code 143, the code of a process ended by SIGTERM. */
  readonly kill: () => void;
  readonly exited: Promise<number>;
  /** Every JSON-RPC message the client wrote, parsed, in the order it was written. */
  readonly received: ReadonlyArray<JsonRpcMessage>;
  /** Puts one raw line on stdout, for a line that is malformed or not in the recording. */
  readonly sendLine: (text: string) => void;
  /** Makes `stdout` fail with `error` after the lines already sent, the way a broken pipe does. */
  readonly failOutput: (error: unknown) => void;
  /** Makes every later `write` reject with `error`. */
  readonly failWrites: (error?: unknown) => void;
  /** Whether the client stopped reading `stdout` before its end. */
  readonly isReadingStopped: () => boolean;
}

const isJsonRpcMessage = (value: unknown): value is JsonRpcMessage =>
  typeof value === "object" && value !== null && "jsonrpc" in value && value.jsonrpc === "2.0";

/**
 * Reads a recording from `./recordings`. Lines that are not JSON-RPC messages,
 * such as the `{"finished": ...}` marker the recorder wrote, are left out.
 * Fails when the file cannot be read or a line is not JSON.
 */
export const readRecording = (name: RecordingName): ReadonlyArray<RecordedMessage> => {
  const text = readFileSync(new URL(`./recordings/${name}.jsonl`, import.meta.url), "utf8");
  const recorded: Array<RecordedMessage> = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const entry: unknown = JSON.parse(line);
    if (
      typeof entry === "object" &&
      entry !== null &&
      "direction" in entry &&
      (entry.direction === "in" || entry.direction === "out") &&
      "message" in entry &&
      isJsonRpcMessage(entry.message)
    ) {
      recorded.push({ direction: entry.direction, message: entry.message });
    }
  }
  return recorded;
};

const isRequest = (message: JsonRpcMessage): boolean =>
  message.method !== undefined && message.id !== undefined;

const isReply = (message: JsonRpcMessage): boolean =>
  message.method === undefined && message.id !== undefined;

/**
 * A recorded client request in the setup part, with the harness messages that
 * followed it: its reply, and any updates sent right after the reply.
 */
interface SetupGroup {
  readonly request: JsonRpcMessage;
  readonly harnessMessages: Array<JsonRpcMessage>;
  used: boolean;
}

/**
 * Splits the setup part of a recording into groups. A group starts at a client
 * request and ends at the next message of the client, whatever it is.
 */
const buildSetupGroups = (setup: ReadonlyArray<RecordedMessage>): Array<SetupGroup> => {
  const groups: Array<SetupGroup> = [];
  let current: SetupGroup | undefined;
  for (const { direction, message } of setup) {
    if (direction === "out") {
      current = isRequest(message)
        ? { request: message, harnessMessages: [], used: false }
        : undefined;
      if (current !== undefined) groups.push(current);
    } else {
      current?.harnessMessages.push(message);
    }
  }
  return groups;
};

/**
 * Returns a queue of lines that can be read as an async iterable. Lines
 * pushed before anyone reads are kept. After `end` or `fail`, the lines that
 * are queued are still read before the reader sees the end or the failure,
 * and a line pushed before the reader has seen it is read too. A line pushed
 * after that does nothing.
 */
const createLineQueue = (
  onReadingStopped: () => void,
): {
  readonly lines: AsyncIterable<string>;
  readonly push: (line: string) => void;
  readonly end: () => void;
  readonly fail: (error: unknown) => void;
} => {
  const pending: Array<string> = [];
  let wake: (() => void) | undefined;
  let ending = false;
  let failure: { readonly error: unknown } | undefined;
  let finished = false;
  const iterator: AsyncIterator<string> = {
    next: async () => {
      for (;;) {
        if (pending.length > 0) return { done: false, value: pending.shift()! };
        if (failure !== undefined) {
          finished = true;
          throw failure.error;
        }
        if (ending) {
          finished = true;
          return { done: true, value: undefined };
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
    // Called when the reader stops before the end.
    return: () => {
      finished = true;
      onReadingStopped();
      return Promise.resolve({ done: true, value: undefined });
    },
  };
  return {
    lines: { [Symbol.asyncIterator]: () => iterator },
    push: (line) => {
      if (finished) return;
      pending.push(line);
      wake?.();
    },
    end: () => {
      ending = true;
      wake?.();
    },
    fail: (error) => {
      failure = { error };
      wake?.();
    },
  };
};

/**
 * Starts a fake harness that answers from `options.recording` and
 * `options.scripts`.
 *
 * The recording has two parts. The setup part is everything before the first
 * `session/prompt`, such as `initialize` and `session/new`. A client request in
 * it is answered by method, in any order, because an adapter does not have to
 * send its setup requests in the order the recording script did. For each
 * request the fake sends the first unused recorded request of that method,
 * with the harness messages that followed it.
 *
 * The turn part starts at the first `session/prompt` and is played in order.
 * Harness messages are sent as they come up. A client message in the recording
 * is a gate: the fake waits until the client writes the matching message, which
 * is a request with the same method for a request (a second `session/prompt`
 * included), a notification with the same method for a notification
 * (`session/cancel`), or a reply with the same id for a reply to a harness
 * request such as an approval request.
 *
 * A client request outside the gates is answered, in this order, by the
 * script of `options.scripts` for its method, by the setup part of the
 * recording, or else with the error -32601 whose message says that nothing has
 * a reply for the method. Other client notifications and replies are only
 * kept in `received`.
 *
 * `options.onChange` is called after the client wrote a line and after it
 * stopped reading `stdout`, so that a test can wait for either.
 *
 * A recorded reply is sent with the id the client used for its request. The
 * ids of harness requests are sent as recorded, and so is the session id.
 */
export const startFakeHarness = (
  options: {
    readonly recording?: ReadonlyArray<RecordedMessage>;
    readonly scripts?: Readonly<Record<string, HarnessScript>>;
    readonly onChange?: () => void;
  } = {},
): FakeHarness => {
  const { recording = [], scripts = {}, onChange = () => undefined } = options;
  const firstPrompt = recording.findIndex(
    ({ direction, message }) => direction === "out" && message.method === "session/prompt",
  );
  const turnStart = firstPrompt === -1 ? recording.length : firstPrompt;
  const setupGroups = buildSetupGroups(recording.slice(0, turnStart));
  const turn = recording.slice(turnStart);
  let cursor = 0;

  let readingStopped = false;
  const stdout = createLineQueue(() => {
    readingStopped = true;
    onChange();
  });
  const stderr = createLineQueue(() => undefined);
  const received: Array<JsonRpcMessage> = [];
  let writeFailure: { readonly error: unknown } | undefined;
  // Maps the id a recorded request had to the id the client gave its request.
  const clientIds = new Map<string | number, string | number>();
  let pendingText = "";
  let closed = false;
  let resolveExited: (code: number) => void = () => undefined;
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });

  const sendRecorded = (message: JsonRpcMessage): void => {
    const clientId = isReply(message) ? clientIds.get(message.id!) : undefined;
    stdout.push(JSON.stringify(clientId === undefined ? message : { ...message, id: clientId }));
  };

  /** Sends the harness messages at the cursor, up to the next client message. */
  const playUntilGate = (): void => {
    while (cursor < turn.length && turn[cursor]!.direction === "in") {
      sendRecorded(turn[cursor]!.message);
      cursor += 1;
    }
  };

  const matchesGate = (gate: JsonRpcMessage, message: JsonRpcMessage): boolean =>
    isReply(gate)
      ? isReply(message) && message.id === gate.id
      : message.method === gate.method && isRequest(message) === isRequest(gate);

  const answerRequest = (request: JsonRpcMessage): void => {
    const id = request.id!;
    const method = request.method!;
    const group = setupGroups.find(
      (candidate) => !candidate.used && candidate.request.method === method,
    );
    if (Object.hasOwn(scripts, method)) {
      for (const line of scripts[method]!({ id, params: request.params }, harness)) {
        stdout.push(typeof line === "string" ? line : JSON.stringify(line));
      }
    } else if (group !== undefined) {
      group.used = true;
      clientIds.set(group.request.id!, id);
      for (const message of group.harnessMessages) sendRecorded(message);
    } else {
      const error = {
        code: -32601,
        message: `Nothing has a reply for the method ${method}. Record one, or pass a script for it in \`scripts\`.`,
      };
      stdout.push(JSON.stringify({ jsonrpc: "2.0", id, error }));
    }
  };

  const handleClientMessage = (message: JsonRpcMessage): void => {
    received.push(message);
    // The turn always stops at a client message, so the cursor is at a gate.
    const gate = turn[cursor]?.message;
    if (gate !== undefined && matchesGate(gate, message)) {
      if (isRequest(gate) && isRequest(message)) clientIds.set(gate.id!, message.id!);
      cursor += 1;
      playUntilGate();
    } else if (isRequest(message)) {
      answerRequest(message);
    }
  };

  const handleLine = (line: string): void => {
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`The client wrote a line that is not JSON: ${line}`);
    }
    if (!isJsonRpcMessage(parsed)) {
      throw new Error(`The client wrote JSON that is not a JSON-RPC 2.0 message: ${line}`);
    }
    handleClientMessage(parsed);
  };

  const close = (exitCode: number): void => {
    if (closed) return;
    closed = true;
    stdout.end();
    stderr.end();
    resolveExited(exitCode);
  };

  const harness: FakeHarness = {
    write: (text) =>
      new Promise<void>((resolve, reject) => {
        if (writeFailure !== undefined) {
          // oxlint-disable-next-line typescript/prefer-promise-reject-errors
          reject(writeFailure.error);
          return;
        }
        if (!closed) {
          pendingText += text;
          const lines = pendingText.split("\n");
          pendingText = lines.pop() ?? "";
          for (const line of lines) handleLine(line);
          onChange();
        }
        resolve();
      }),
    stdout: stdout.lines,
    stderr: stderr.lines,
    end: () => {
      close(0);
    },
    kill: () => {
      close(143);
    },
    exited,
    received,
    sendLine: stdout.push,
    failOutput: stdout.fail,
    failWrites: (error = new Error("EPIPE")) => {
      writeFailure = { error };
    },
    isReadingStopped: () => readingStopped,
  };
  return harness;
};
