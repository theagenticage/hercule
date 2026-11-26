/**
 * Checks the Antigravity adapter's sessions against the real `agy` and a real
 * Google login. A real model answers, so these tests use the network and the
 * account's quota. They skip unless both of these exist:
 *
 * - `agy`: `HERCULE_AGY_TEST_BINARY`, or `agy` on the `PATH`.
 * - `HERCULE_AGY_TEST_LOGIN`: the path of an `antigravity-oauth-token` file
 *   that a person lends, taken from a signed-in Harness Home.
 *
 * The token is copied into a scratch Harness Home (mode 0700) as a file with
 * mode 0600, and the home is deleted at the end. The token is never printed.
 * The binary is copied into a temporary folder and only the copy is run,
 * because `agy` can replace its own binary. Every process gets an environment
 * built from nothing: a temporary `HOME` and a short `PATH`.
 *
 * Each test drives the adapter only through `HarnessAdapter`, and states the
 * spec rule it proves (spec 06 sections 6.2, 6.5, 8.1 and 10.5). When a test
 * fails, its message lists the events `agy` produced, so that the failure says
 * what `agy` did.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import type {
  ApprovalDecision,
  ExitReason,
  HarnessEvent,
  ModelDescriptor,
  SessionSpec,
} from "@hercule/protocol";
import { runProcess, spawnAgy } from "../process";
import type { AdapterTurnInput, HarnessAdapter, SessionStartContext } from "../index";
import { makeAntigravityAdapter } from "./adapter";
import { findAgyTestBinary } from "./agy-binary.testing";
import { buildContext } from "./fake-agy.testing";
import { APP_DATA_DIR } from "./harness-home";

const pinnedBinary = findAgyTestBinary();
const loginFile = process.env["HERCULE_AGY_TEST_LOGIN"];

const skipReason =
  pinnedBinary === undefined
    ? "no agy binary (HERCULE_AGY_TEST_BINARY, or agy on PATH)"
    : loginFile === undefined || loginFile === ""
      ? "HERCULE_AGY_TEST_LOGIN is not set: no lent Google login"
      : undefined;

/** The time one test gets. A real model answers, so this is generous. */
const TEST_MS = 120_000;

/** How long a wait for one thing from `agy` lasts. It stays below `TEST_MS`, so the wait's own message wins. */
const WAIT_MS = 100_000;

/** How long `agy` gets to end a turn after an interrupt (spec 06 section 6.2). */
const INTERRUPT_MS = 5_000;

type Event<Tag extends HarnessEvent["_tag"]> = Extract<HarnessEvent, { _tag: Tag }>;
type OpenedRequest = Event<"request.opened">["request"];

const adapter: HarnessAdapter = makeAntigravityAdapter({ spawn: spawnAgy, run: runProcess });

const scratchFolders: Array<string> = [];
const startedSessions = new Set<string>();
const eventsBySession = new Map<string, Array<HarnessEvent>>();

let collector: Fiber.Fiber<unknown, unknown> | undefined;
let binaryPath = "";
let harnessHome = "";
let userHome = "";
let cheapModel = "";
let otherModel = "";
/** Words that name the other model's family and not the cheap model's, such as "carbon" against "neon". */
let otherModelFamilyWords: ReadonlyArray<string> = [];

const makeScratchFolder = (label: string): string => {
  const folder = mkdtempSync(join(tmpdir(), `hercule-agy-live-${label}-`));
  scratchFolders.push(folder);
  return folder;
};

/** Makes every file and folder below `path` writable by the owner, because `agy` creates some with narrower modes. */
const makeTreeWritable = (path: string): void => {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    chmodSync(path, stat.isDirectory() ? 0o700 : 0o600);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) makeTreeWritable(join(path, name));
    }
  } catch {
    // What cannot be changed is reported by the `rmSync` that follows.
  }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

const eventsOf = (sessionId: string): ReadonlyArray<HarnessEvent> =>
  eventsBySession.get(sessionId) ?? [];

/** Names one event in a line, for the failure message. */
const describeEvent = (event: HarnessEvent): string => {
  switch (event._tag) {
    case "item.started":
    case "item.updated":
      return `${event._tag}(${event.kind})`;
    case "item.completed":
      return `item.completed(${event.kind}, ${event.status})`;
    case "content.delta":
      return `content.delta(${event.streamKind})`;
    case "turn.completed":
      return `turn.completed(${event.state}${event.error === undefined ? "" : `: ${event.error}`})`;
    case "request.opened":
      return `request.opened(${event.request.kind})`;
    case "request.resolved":
      return `request.resolved(${"decision" in event ? event.decision : "answers"})`;
    case "session.exited":
      return `session.exited(${event.reason})`;
    case "runtime.error":
      return `runtime.error(${event.class}: ${event.message ?? ""})`;
    case "runtime.warning":
    case "runtime.notice":
      return `${event._tag}(${event.message})`;
    default:
      return event._tag;
  }
};

/** Lists what `agy` did in a session, in order, with runs of the same event folded into "x N". */
const dumpEvents = (sessionId: string): string => {
  const lines: Array<string> = [];
  let last = "";
  let count = 0;
  const flush = (): void => {
    if (count > 0) lines.push(count === 1 ? last : `${last} x ${String(count)}`);
  };
  for (const event of eventsOf(sessionId)) {
    const line = describeEvent(event);
    if (line === last) {
      count += 1;
      continue;
    }
    flush();
    last = line;
    count = 1;
  }
  flush();
  return `What agy did in the session, in order:\n  ${lines.join("\n  ")}`;
};

const assistantText = (events: ReadonlyArray<HarnessEvent>): string =>
  events
    .filter((event): event is Event<"content.delta"> => event._tag === "content.delta")
    .filter((event) => event.streamKind === "assistant_text")
    .map((event) => event.delta)
    .join("");

/**
 * Waits until `find` returns a value for the events of the session, and returns
 * it. Fails with a message that lists the session's events when the wait ends
 * first.
 */
const waitFor = async <T>(
  sessionId: string,
  what: string,
  find: (events: ReadonlyArray<HarnessEvent>) => T | undefined,
  timeoutMs: number = WAIT_MS,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = find(eventsOf(sessionId));
    if (found !== undefined) return found;
    if (Date.now() > deadline) {
      throw new Error(
        `agy never ${what} within ${String(timeoutMs)} ms.\n${dumpEvents(sessionId)}`,
      );
    }
    await sleep(25);
  }
};

const findTurnEnd = (
  events: ReadonlyArray<HarnessEvent>,
  turnId: string,
): Event<"turn.completed"> | undefined =>
  events.find(
    (event): event is Event<"turn.completed"> =>
      event._tag === "turn.completed" && event.turnId === turnId,
  );

const findOpenedRequest = (
  events: ReadonlyArray<HarnessEvent>,
  kind: OpenedRequest["kind"],
): OpenedRequest | undefined =>
  events.find(
    (event): event is Event<"request.opened"> =>
      event._tag === "request.opened" && event.request.kind === kind,
  )?.request;

interface LiveSession {
  readonly id: string;
  readonly nativeSessionId: string;
  readonly cwd: string;
}

interface StartOptions {
  readonly accessMode: SessionSpec["accessMode"];
  readonly systemPrompt?: string;
  readonly continue?: SessionSpec["continue"];
  /** Reuses the work folder of an earlier session, as a resume does. */
  readonly cwd?: string;
}

const buildSpec = (options: StartOptions): SessionSpec => ({
  providerAccountId: "0199e0e7-0000-7000-8000-0000000000aa",
  workspaceId: null,
  modelSelection: { model: cheapModel, options: {} },
  accessMode: options.accessMode,
  timeouts: { inactivityMs: 1_800_000, absoluteMs: 28_800_000 },
  ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
  ...(options.continue === undefined ? {} : { continue: options.continue }),
});

/** The environment of every `agy` process: nothing of the developer's own. The network stays on. */
const buildProbeEnvironment = (): Record<string, string> => ({
  HOME: userHome,
  PATH: "/usr/bin:/bin",
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent",
});

const buildStartContext = (cwd: string): SessionStartContext => ({
  ...buildContext(harnessHome, binaryPath, buildProbeEnvironment()),
  cwd,
  mcpServers: [],
});

/** Starts a session in a fresh work folder (or the one given), and records it so that the end of the suite stops it. */
const startLiveSession = async (options: StartOptions): Promise<LiveSession> => {
  const id = crypto.randomUUID();
  const cwd = options.cwd ?? makeScratchFolder("work");
  eventsBySession.set(id, []);
  startedSessions.add(id);
  const binding = await run(adapter.startSession(id, buildSpec(options), buildStartContext(cwd)));
  return { id, nativeSessionId: binding.nativeSessionId, cwd };
};

interface TurnResult {
  /** The events from the input to the end of its turn. */
  readonly events: ReadonlyArray<HarnessEvent>;
  readonly completed: Event<"turn.completed">;
}

interface TurnOptions {
  /** Decides each approval. Allows every one when absent. */
  readonly decide?: (request: OpenedRequest) => ApprovalDecision;
  readonly input?: Partial<AdapterTurnInput>;
}

/** Sends `text` and decides the approvals the turn opens, until the turn ends. */
const runTurn = async (
  session: LiveSession,
  text: string,
  options: TurnOptions = {},
): Promise<TurnResult> => {
  const mark = eventsOf(session.id).length;
  const sent = await run(adapter.sendInput(session.id, { text, ...options.input }));
  const decided = new Set<string>();
  const completed = await waitFor(session.id, `ended the turn of "${text}"`, (events) => {
    for (const event of events.slice(mark)) {
      if (event._tag !== "request.opened" || event.request.kind === "question") continue;
      if (decided.has(event.request.requestId)) continue;
      decided.add(event.request.requestId);
      const decision = options.decide?.(event.request) ?? "allow";
      Effect.runFork(
        adapter.respondToApprovalRequest(session.id, event.request.requestId, decision),
      );
    }
    return findTurnEnd(events, sent.turnId);
  });
  return { events: eventsOf(session.id).slice(mark), completed };
};

const stopLiveSession = async (session: LiveSession, reason: ExitReason): Promise<void> => {
  await Effect.runPromise(adapter.stopSession(session.id, reason));
};

/** Encodes a solid-colour PNG of `size` by `size` pixels, so the test needs no image file in the repository. */
const buildSolidPng = (
  size: number,
  [red, green, blue]: readonly [number, number, number],
): Buffer => {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1)
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  const crc32 = (bytes: Buffer): number => {
    let value = 0xffffffff;
    for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array(size).fill([red, green, blue]).flat()),
  ]);
  const pixels = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

/** Picks the account's cheapest model: one with `flash` in its id when listed, else the default, else the first. */
const pickCheapModel = (models: ReadonlyArray<ModelDescriptor>): ModelDescriptor | undefined =>
  models.find((model) => /flash/i.test(model.slug)) ??
  models.find((model) => model.isDefault === true) ??
  models[0];

beforeAll(async () => {
  if (skipReason !== undefined || pinnedBinary === undefined || loginFile === undefined) return;
  const binaryFolder = makeScratchFolder("binary");
  binaryPath = join(binaryFolder, "agy");
  copyFileSync(pinnedBinary, binaryPath);
  chmodSync(binaryPath, 0o755);

  userHome = makeScratchFolder("home");
  harnessHome = makeScratchFolder("harness-home");
  chmodSync(harnessHome, 0o700);
  mkdirSync(join(harnessHome, APP_DATA_DIR), { recursive: true });
  // The token is copied unread and never printed.
  writeFileSync(
    join(harnessHome, APP_DATA_DIR, "antigravity-oauth-token"),
    readFileSync(loginFile),
    { mode: 0o600 },
  );

  collector = Effect.runFork(
    Stream.runForEach(adapter.events, (event) =>
      Effect.sync(() => eventsBySession.get(event.sessionId)?.push(event)),
    ),
  );

  const probed = await Effect.runPromise(
    adapter.probe(buildContext(harnessHome, binaryPath, buildProbeEnvironment()), {
      readUsage: false,
    }),
  );
  if (probed.auth.status !== "ok") {
    throw new Error(
      `The lent login is not signed in: the probe reported "${probed.auth.status}". Lend the token of a signed-in Harness Home.`,
    );
  }
  const cheap = pickCheapModel(probed.models);
  const other = probed.models.find((model) => model.slug !== cheap?.slug);
  if (cheap === undefined || other === undefined) {
    throw new Error(
      `The account lists ${String(probed.models.length)} models; these tests need at least two.`,
    );
  }
  cheapModel = cheap.slug;
  otherModel = other.slug;
  const wordsOf = (name: string): ReadonlyArray<string> =>
    name.toLowerCase().match(/[a-z]{3,}/g) ?? [];
  const cheapWords = new Set(wordsOf(cheap.name));
  otherModelFamilyWords = wordsOf(other.name).filter((word) => !cheapWords.has(word));
  if (otherModelFamilyWords.length === 0) {
    throw new Error(
      `The names "${cheap.name}" and "${other.name}" share every word, so a reply cannot tell the models apart.`,
    );
  }
}, 120_000);

afterAll(async () => {
  for (const id of startedSessions) {
    await Effect.runPromise(adapter.stopSession(id, "stopped")).catch(() => undefined);
  }
  if (collector !== undefined) await Effect.runPromise(Fiber.interrupt(collector));
  for (const folder of scratchFolders.splice(0)) {
    makeTreeWritable(folder);
    rmSync(folder, { recursive: true, force: true });
  }
}, 60_000);

describe.skipIf(skipReason !== undefined)(
  skipReason === undefined
    ? "Antigravity sessions on the real agy and a real model"
    : `Antigravity sessions on the real agy and a real model (skipped: ${skipReason})`,
  () => {
    it(
      "opens a file_change_approval and a command_approval under approval-required, and runs both once allowed (spec 06 section 8.1)",
      async () => {
        const session = await startLiveSession({ accessMode: "approval-required" });
        writeFileSync(join(session.cwd, "notes.txt"), "old\n");

        const turn = await runTurn(
          session,
          "Edit the file notes.txt in the current folder so that it contains only the line: hello. Then run the command `ls`. Do nothing else.",
        );
        const why = dumpEvents(session.id);

        const kinds = turn.events.flatMap((event) =>
          event._tag === "request.opened" ? [event.request.kind] : [],
        );
        expect(kinds, why).toContain("file_change_approval");
        expect(kinds, why).toContain("command_approval");
        expect(turn.completed.state, why).toBe("completed");
        expect(readFileSync(join(session.cwd, "notes.txt"), "utf8"), why).toContain("hello");
        const edit = turn.events.find(
          (event): event is Event<"item.completed"> =>
            event._tag === "item.completed" && event.kind === "file_change",
        );
        expect(edit, why).toBeDefined();
        expect(JSON.stringify([edit?.detail, edit?.editedFiles]), why).toContain("notes.txt");
      },
      TEST_MS,
    );

    it(
      "continues the turn after a denied command: the model answers, the command did not run, and the item is declined (spec 06 section 6.5)",
      async () => {
        const session = await startLiveSession({ accessMode: "approval-required" });

        const turn = await runTurn(
          session,
          "Run `touch denied.txt`, then reply with the single word DONE.",
          { decide: (request) => (request.kind === "command_approval" ? "deny" : "allow") },
        );
        const why = dumpEvents(session.id);

        const declinedAt = turn.events.findIndex(
          (event) =>
            event._tag === "item.completed" &&
            event.kind === "command_execution" &&
            event.status === "declined",
        );
        expect(declinedAt, `no declined command item.\n${why}`).toBeGreaterThanOrEqual(0);
        const answeredAfterDecline = turn.events
          .slice(declinedAt)
          .some((event) => event._tag === "item.completed" && event.kind === "assistant_message");
        expect(answeredAfterDecline, `the turn did not go on after the decline.\n${why}`).toBe(
          true,
        );
        expect(existsSync(join(session.cwd, "denied.txt")), why).toBe(false);
        expect(turn.completed.state, why).toBe("completed");
      },
      TEST_MS,
    );

    it(
      "ends a running command's turn as interrupted within 5 seconds, and the session takes the next input (spec 06 section 6.2)",
      async () => {
        const session = await startLiveSession({ accessMode: "full-access" });
        const sent = await run(
          adapter.sendInput(session.id, {
            text: "Run the command `sleep 30` and wait for it to finish.",
          }),
        );
        await waitFor(session.id, "started a command", (events) =>
          events.find(
            (event) => event._tag === "item.started" && event.kind === "command_execution",
          ),
        );

        const interruptedAt = Date.now();
        await Effect.runPromise(adapter.interrupt(session.id));
        const ended = await waitFor(
          session.id,
          "ended the turn after the interrupt",
          (events) => findTurnEnd(events, sent.turnId),
          INTERRUPT_MS * 2,
        );
        const why = dumpEvents(session.id);

        expect(ended.state, why).toBe("interrupted");
        expect(Date.now() - interruptedAt, why).toBeLessThan(INTERRUPT_MS);
        const next = await runTurn(session, "Reply with the single word OK.");
        expect(next.completed.state, dumpEvents(session.id)).toBe("completed");
      },
      TEST_MS,
    );

    it(
      "resolves an open approval as cancel and ends the turn as interrupted when the turn is interrupted (spec 06 section 6.5)",
      async () => {
        const session = await startLiveSession({ accessMode: "approval-required" });
        const sent = await run(
          adapter.sendInput(session.id, {
            text: "Run the command `touch asked.txt`. Nothing else.",
          }),
        );
        const request = await waitFor(session.id, "opened a command approval", (events) =>
          findOpenedRequest(events, "command_approval"),
        );

        await Effect.runPromise(adapter.interrupt(session.id));
        const ended = await waitFor(session.id, "ended the turn", (events) =>
          findTurnEnd(events, sent.turnId),
        );
        const why = dumpEvents(session.id);

        const resolution = eventsOf(session.id).find(
          (event): event is Event<"request.resolved"> =>
            event._tag === "request.resolved" && event.requestId === request.requestId,
        );
        expect(resolution && "decision" in resolution ? resolution.decision : undefined, why).toBe(
          "cancel",
        );
        expect(ended.state, why).toBe("interrupted");
        expect(existsSync(join(session.cwd, "asked.txt")), why).toBe(false);
      },
      TEST_MS,
    );

    it(
      "applies the instructions in spec.systemPrompt, applies the ones given on a resume instead, and keeps the conversation without replaying the old events (spec 06 sections 9.2 and 10.5)",
      async () => {
        const systemPrompt =
          "The secret word is PELICAN. When asked for the secret word, reply with it alone.";
        const first = await startLiveSession({ accessMode: "full-access", systemPrompt });

        const secret = await runTurn(first, "What is the secret word?");
        expect(assistantText(secret.events).toUpperCase(), dumpEvents(first.id)).toContain(
          "PELICAN",
        );
        await runTurn(first, "Remember the number 7. Reply with the single word OK.");
        const firstItemIds = new Set(
          eventsOf(first.id).flatMap((event) =>
            event._tag === "item.completed" ? [event.itemId] : [],
          ),
        );
        await stopLiveSession(first, "stopped");
        expect(
          eventsOf(first.id).some(
            (event) => event._tag === "session.exited" && event.reason === "stopped",
          ),
          dumpEvents(first.id),
        ).toBe(true);

        // Different instructions on the resume: the recordings cannot tell
        // whether a resume applies its own or keeps those of the first process.
        const resumedPrompt =
          "The secret word is HERON. When asked for the secret word, reply with it alone.";
        const resumed = await startLiveSession({
          accessMode: "full-access",
          systemPrompt: resumedPrompt,
          cwd: first.cwd,
          continue: { nativeSessionId: first.nativeSessionId, mode: "resume" },
        });
        const number = await runTurn(
          resumed,
          "What number did I ask you to remember? Reply with the number alone.",
        );
        const word = await runTurn(resumed, "What is the secret word?");
        const why = dumpEvents(resumed.id);

        expect(assistantText(number.events), why).toContain("7");
        const resumedWord = assistantText(word.events).toUpperCase();
        expect(resumedWord, why).toContain("HERON");
        expect(resumedWord, why).not.toContain("PELICAN");
        const resumedEvents = eventsOf(resumed.id);
        const replayedItems = resumedEvents.filter(
          (event) => event._tag === "item.completed" && firstItemIds.has(event.itemId),
        );
        expect(replayedItems, `an item of the first process came again.\n${why}`).toEqual([]);
        // Only the two turns of this process may produce items, so the old
        // conversation was not replayed as new ones.
        const turnIds = new Set([number, word].map((turn) => turn.completed.turnId));
        const strayItems = resumedEvents.filter(
          (event) =>
            (event._tag === "item.started" ||
              event._tag === "item.updated" ||
              event._tag === "item.completed") &&
            !turnIds.has(event.turnId),
        );
        expect(strayItems, `items outside the two new turns.\n${why}`).toEqual([]);
        const firstTurnStart = resumedEvents.findIndex((event) => event._tag === "turn.started");
        const earlyUsage = resumedEvents
          .slice(0, Math.max(firstTurnStart, 0))
          .filter((event) => event._tag === "session.usage.updated");
        expect(earlyUsage, `usage was reported before any turn of this process.\n${why}`).toEqual(
          [],
        );
      },
      TEST_MS * 2,
    );

    it(
      "fails a resume of a conversation agy does not have with ResumeTranscriptMissing (spec 06 section 4.1)",
      async () => {
        const id = crypto.randomUUID();
        eventsBySession.set(id, []);
        startedSessions.add(id);
        const error = await Effect.runPromise(
          Effect.flip(
            adapter.startSession(
              id,
              buildSpec({
                accessMode: "full-access",
                continue: { nativeSessionId: crypto.randomUUID(), mode: "resume" },
              }),
              buildStartContext(makeScratchFolder("work")),
            ),
          ),
        );

        expect(error._tag, `the start failed with ${error.message}`).toBe(
          "ResumeTranscriptMissing",
        );
      },
      TEST_MS,
    );

    it(
      "asks nothing for an edit inside the workspace under auto-accept-edits, whose mode agy confirmed (spec 06 section 8.1)",
      async () => {
        const session = await startLiveSession({ accessMode: "auto-accept-edits" });

        const turn = await runTurn(
          session,
          "Create a file named made.txt in the current folder that contains the word ok. Do nothing else.",
        );
        const why = dumpEvents(session.id);

        expect(
          turn.events.filter((event) => event._tag === "request.opened"),
          why,
        ).toEqual([]);
        expect(existsSync(join(session.cwd, "made.txt")), why).toBe(true);
        expect(turn.completed.state, why).toBe("completed");
      },
      TEST_MS,
    );

    it(
      "opens a multi-select question Request, and answering with two labels reaches the agent (spec 06 section 6.5)",
      async () => {
        const session = await startLiveSession({ accessMode: "approval-required" });
        const mark = eventsOf(session.id).length;
        const sent = await run(
          adapter.sendInput(session.id, {
            text: 'Use your question tool to ask me one multi-select question, "Pick the colours you like", with exactly the options Red, Green and Blue. Wait for my answer, then reply with the colours I chose in one short sentence.',
          }),
        );
        const request = await waitFor(session.id, "opened a question", (events) =>
          findOpenedRequest(events.slice(mark), "question"),
        );
        if (request.kind !== "question") throw new Error("not a question");
        const question = request.detail.questions[0];
        expect(question.multiSelect, dumpEvents(session.id)).toBe(true);

        await run(
          adapter.respondToQuestion(
            session.id,
            request.requestId,
            { [question.header]: ["Red", "Blue"] },
            { model: cheapModel, options: {} },
          ),
        );
        const ended = await waitFor(session.id, "ended the turn", (events) =>
          findTurnEnd(events, sent.turnId),
        );
        const why = dumpEvents(session.id);

        const reply = assistantText(eventsOf(session.id).slice(mark)).toLowerCase();
        expect(reply, why).toContain("red");
        expect(reply, why).toContain("blue");
        expect(ended.state, why).toBe("completed");
      },
      TEST_MS,
    );

    it(
      "asks before a write to a file directly under /tmp in approval-required, because the process's TMPDIR is its own folder (spec 06 section 8.1)",
      async () => {
        const session = await startLiveSession({ accessMode: "approval-required" });
        const target = join("/tmp", `hercule-agy-live-${crypto.randomUUID()}.txt`);

        try {
          const turn = await runTurn(
            session,
            `Create the file ${target} containing the line: hello. Do nothing else.`,
            { decide: () => "deny" },
          );
          const why = dumpEvents(session.id);

          const asked = turn.events.filter(
            (event) => event._tag === "request.opened" && event.request.kind !== "question",
          );
          expect(asked.length, why).toBeGreaterThan(0);
          expect(existsSync(target), why).toBe(false);
        } finally {
          rmSync(target, { force: true });
        }
      },
      TEST_MS,
    );

    it(
      "asks nothing for a command under full-access (spec 06 section 8.1)",
      async () => {
        const session = await startLiveSession({ accessMode: "full-access" });

        const turn = await runTurn(
          session,
          "Run the command `touch ran.txt` in the current folder. Do nothing else.",
        );
        const why = dumpEvents(session.id);

        expect(
          turn.events.filter((event) => event._tag === "request.opened"),
          why,
        ).toEqual([]);
        expect(existsSync(join(session.cwd, "ran.txt")), why).toBe(true);
        expect(turn.completed.state, why).toBe("completed");
      },
      TEST_MS,
    );

    it(
      "opens a question Request for the agent's question tool, and a chosen option reaches the agent (spec 06 section 6.5)",
      async () => {
        const session = await startLiveSession({ accessMode: "approval-required" });
        const mark = eventsOf(session.id).length;
        const sent = await run(
          adapter.sendInput(session.id, {
            text: "Use your question tool to ask me to choose a colour, with exactly the options Red, Green and Blue. Wait for my answer, then reply with the colour I chose in one short sentence.",
          }),
        );
        const request = await waitFor(session.id, "opened a question", (events) =>
          findOpenedRequest(events.slice(mark), "question"),
        );
        if (request.kind !== "question") throw new Error("not a question");
        const header = request.detail.questions[0].header;

        await run(
          adapter.respondToQuestion(
            session.id,
            request.requestId,
            { [header]: "Green" },
            { model: cheapModel, options: {} },
          ),
        );
        const ended = await waitFor(session.id, "ended the turn", (events) =>
          findTurnEnd(events, sent.turnId),
        );
        const why = dumpEvents(session.id);

        const resolution = eventsOf(session.id).find(
          (event): event is Event<"request.resolved"> =>
            event._tag === "request.resolved" && event.requestId === request.requestId,
        );
        expect(resolution && "answers" in resolution ? resolution.answers : undefined, why).toEqual(
          {
            [header]: "Green",
          },
        );
        expect(assistantText(eventsOf(session.id).slice(mark)).toLowerCase(), why).toContain(
          "green",
        );
        expect(ended.state, why).toBe("completed");
      },
      TEST_MS,
    );

    it(
      "switches the model for one input, and refuses an unknown model with ModelChangeRefused while the session keeps running (spec 06 section 6.2)",
      async () => {
        const session = await startLiveSession({ accessMode: "full-access" });

        // No event reports the model in effect, so the model is asked. A
        // model knows its family name, though not always its exact id, so the
        // reply must contain a word of the other model's name that the first
        // model's name does not have.
        const switched = await runTurn(
          session,
          "Which model are you? Answer with your model id only.",
          { input: { modelSelection: { model: otherModel, options: {} } } },
        );
        const why = dumpEvents(session.id);
        expect(switched.completed.state, why).toBe("completed");
        const reply = assistantText(switched.events).toLowerCase();
        expect(
          otherModelFamilyWords.some((word) => reply.includes(word)),
          `the reply "${reply}" names none of ${otherModelFamilyWords.join(", ")}.\n${why}`,
        ).toBe(true);

        const error = await Effect.runPromise(
          Effect.flip(
            adapter.sendInput(session.id, {
              text: "Reply with the single word OK.",
              modelSelection: { model: "no-such-model", options: {} },
            }),
          ),
        );
        expect(error._tag, `the input failed with ${error.message}`).toBe("ModelChangeRefused");

        const listed = await Effect.runPromise(adapter.listSessions);
        expect(listed.map((binding) => binding.sessionId)).toContain(session.id);
        const after = await runTurn(session, "Reply with the single word OK.");
        expect(after.completed.state, dumpEvents(session.id)).toBe("completed");
      },
      TEST_MS,
    );

    it(
      "sends an attached image to the model, which describes its colour (spec 06 section 6.2)",
      async () => {
        const session = await startLiveSession({ accessMode: "full-access" });
        const png = buildSolidPng(32, [255, 0, 0]);
        const path = join(makeScratchFolder("image"), "red.png");
        writeFileSync(path, png);

        const turn = await runTurn(session, "What colour is this image? One word.", {
          input: {
            attachments: [
              {
                id: "0199e0e7-0000-7000-8000-0000000000a1",
                name: "red.png",
                mimeType: "image/png",
                sizeBytes: png.length,
                sha256: createHash("sha256").update(png).digest("hex"),
                path,
              },
            ],
          },
        });
        const why = dumpEvents(session.id);

        expect(assistantText(turn.events).toLowerCase(), why).toContain("red");
        expect(turn.completed.state, why).toBe("completed");
      },
      TEST_MS,
    );
  },
);
