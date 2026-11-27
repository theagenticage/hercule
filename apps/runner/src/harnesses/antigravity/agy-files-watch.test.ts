/**
 * Tests the watcher of `agy`'s session files: when it reads, what it shows, and
 * when it gives up. The files are the recorded ones of `subagent-full`
 * (fixtures/session-files), copied into a scratch Harness Home a piece at a time
 * the way `agy` writes them. Time runs on a `TestClock`, and the reads are real
 * file input and output, so the helpers wait for them in real time, bounded.
 * The session's own routing (what it does with a cancel, an input, an exit) is
 * tested in `session.test.ts`.
 */
import { appendFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import type { HarnessEvent } from "@hercule/protocol";
import { cleanupHomes, createScratchHome, settle } from "../testing";
import type { RootConversationFact } from "./agy-files";
import { watchAgyFiles } from "./agy-files-watch";
import type { AgyFilesWatch } from "./agy-files-watch";
import { APP_DATA_DIR, buildPlanFilePaths } from "./harness-home";
import { buildNormalizerState } from "./normalize";

afterEach(() => {
  cleanupHomes();
});

const SESSION = "0199e0e7-0000-7000-8000-0000000000ff";
const ROOT = "86a5c11a-cc0d-4231-b6a7-4df5e51875e0";
const CHILD = "e4553827-0073-42e6-bc63-8e9619a7d435";
const FIXTURE_BRAIN = join(
  import.meta.dirname,
  "fixtures",
  "session-files",
  "subagent-full",
  "brain",
);

const folderOf = (home: string, id: string): string =>
  join(home, APP_DATA_DIR, "brain", id, ".system_generated");
const transcriptOf = (home: string, id: string): string =>
  join(folderOf(home, id), "logs", "transcript.jsonl");
const readLines = (id: string): ReadonlyArray<string> =>
  readFileSync(join(FIXTURE_BRAIN, id, ".system_generated", "logs", "transcript.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line !== "");

/** The recorded steps of the subagent. Its step 6 ends its turn. */
const CHILD_STEPS = readLines(CHILD);
const ROOT_STEPS = readLines(ROOT);

/** A step the subagent writes after its turn ended: it opens a new turn that completes at once. */
const LATE_STEP = JSON.stringify({
  step_index: 7,
  type: "PLANNER_RESPONSE",
  status: "DONE",
  model: "gemini-4-neon-high",
  content: "Late words.",
});

/** Writes what `agy` writes about a second after the session's agent launches a subagent: the session's transcript up to the call, the registration, and the launch message. */
const registerSubagent = (home: string): void => {
  mkdirSync(dirname(transcriptOf(home, ROOT)), { recursive: true });
  writeFileSync(
    transcriptOf(home, ROOT),
    ROOT_STEPS.slice(0, 3)
      .map((s) => `${s}\n`)
      .join(""),
  );
  cpSync(
    join(FIXTURE_BRAIN, ROOT, ".system_generated", "subagents"),
    join(folderOf(home, ROOT), "subagents"),
    {
      recursive: true,
    },
  );
  cpSync(
    join(FIXTURE_BRAIN, CHILD, ".system_generated", "messages"),
    join(folderOf(home, CHILD), "messages"),
    {
      recursive: true,
    },
  );
};

/** Appends the recorded steps from `from` up to, but not including, `to` to the subagent's transcript. */
const appendChildSteps = (home: string, from: number, to: number): void => {
  mkdirSync(dirname(transcriptOf(home, CHILD)), { recursive: true });
  appendFileSync(
    transcriptOf(home, CHILD),
    CHILD_STEPS.slice(from, to)
      .map((step) => `${step}\n`)
      .join(""),
  );
};

interface Watching {
  readonly home: string;
  readonly watch: AgyFilesWatch;
  readonly published: Array<HarnessEvent>;
  readonly facts: Array<RootConversationFact>;
  /** Says whether the session's own work is open, as the session does. */
  readonly setSessionWorkOpen: (isOpen: boolean) => void;
}

/** Starts a watcher over a scratch home. The home is created before `prepare` runs, so files can exist when the watcher opens. */
const startWatching = (
  options: {
    readonly prepare?: (home: string) => void;
    readonly resumes?: boolean;
    readonly known?: ReadonlyArray<{ readonly subagentId: string }>;
  } = {},
): Effect.Effect<Watching, never, Scope.Scope> =>
  Effect.gen(function* () {
    const home = createScratchHome("agy-files-watch");
    options.prepare?.(home);
    const published: Array<HarnessEvent> = [];
    const facts: Array<RootConversationFact> = [];
    let isSessionWorkOpen = false;
    const watch = yield* watchAgyFiles({
      home,
      conversationId: ROOT,
      resumes: options.resumes ?? false,
      known: options.known ?? [],
      normalizer: buildNormalizerState({
        sessionId: SESSION,
        nativeSessionId: ROOT,
        planFilePaths: buildPlanFilePaths(home, ROOT),
      }),
      isSessionWorkOpen: () => isSessionWorkOpen,
      publish: (events) => published.push(...events),
      recordRootConversationFact: (fact) => facts.push(fact),
    });
    return {
      home,
      watch,
      published,
      facts,
      setSessionWorkOpen: (isOpen) => {
        isSessionWorkOpen = isOpen;
      },
    };
  });

const run = (program: Effect.Effect<void, never, Scope.Scope | TestClock.TestClock>) =>
  Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(TestClock.layer())));

const tags = <T extends HarnessEvent["_tag"]>(w: Watching, tag: T) =>
  w.published.filter((event): event is Extract<HarnessEvent, { _tag: T }> => event._tag === tag);
const isChild = (event: HarnessEvent): boolean =>
  "subagentId" in event && event.subagentId === CHILD;
/** Describes the subagent's turns in order, as `started` or `ended <state>`. */
const summarizeChildTurns = (w: Watching) =>
  w.published
    .filter(
      (event) =>
        isChild(event) && (event._tag === "turn.started" || event._tag === "turn.completed"),
    )
    .map((event) => (event._tag === "turn.completed" ? `ended ${event.state}` : "started"));
const childEnded = (w: Watching, state: string) => () =>
  summarizeChildTurns(w).includes(`ended ${state}`);
const childStarted = (w: Watching) => () => summarizeChildTurns(w).includes("started");

/** Waits in real time, up to `limitMs`, until `ready` returns true. */
const pollFor = async (ready: () => boolean, limitMs: number): Promise<boolean> => {
  const deadline = Date.now() + limitMs;
  while (!ready() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
  return ready();
};

/**
 * Lets the watcher read until `ready` returns true. Each round runs the 500 ms
 * between two reads out, then waits in real time for the read to show its
 * result. Fails the test when 10 rounds did not get there.
 */
const readUntil = (what: string, ready: () => boolean) =>
  Effect.gen(function* () {
    for (let rounds = 0; rounds < 10 && !ready(); rounds += 1) {
      yield* TestClock.adjust(Duration.millis(500));
      yield* Effect.promise(() => pollFor(ready, 250));
    }
    expect(ready(), `the files never showed ${what}`).toBe(true);
  });

/** Runs the clock out by `duration` in steps of half a second, and lets every read in between finish. A test that then sees nothing new can trust the watcher had every chance to show it. */
const runOutClock = (duration: Duration.Duration) =>
  Effect.gen(function* () {
    for (let elapsed = 0; elapsed < Duration.toMillis(duration); elapsed += 500) {
      yield* TestClock.adjust(Duration.millis(500));
      yield* Effect.promise(settle);
    }
  });

/** Opens the session's work and wakes the watcher, as the session does when a Turn starts. */
const openWork = (w: Watching) =>
  Effect.sync(() => {
    w.setSessionWorkOpen(true);
    w.watch.wake();
  });

describe("when the watcher reads", () => {
  it("reads for 2 seconds after the last work closed, so a later step shows, and then reads nothing until work opens again", () =>
    run(
      Effect.gen(function* () {
        const w = yield* startWatching();
        yield* openWork(w);
        yield* Effect.promise(settle);
        w.setSessionWorkOpen(false);

        // The files of the subagent show up after the session's work closed.
        yield* TestClock.adjust(Duration.millis(550));
        registerSubagent(w.home);
        appendChildSteps(w.home, 0, 7);
        yield* readUntil("the end of the subagent's turn", childEnded(w, "completed"));
        expect(summarizeChildTurns(w)).toEqual(["started", "ended completed"]);

        // Nothing is open once the 2 seconds are over, so a new step waits however long the clock runs.
        yield* runOutClock(Duration.seconds(3));
        const shown = w.published.length;
        appendFileSync(transcriptOf(w.home, CHILD), `${LATE_STEP}\n`);
        yield* runOutClock(Duration.seconds(30));
        expect(w.published).toHaveLength(shown);

        // Work that opens makes it read again.
        yield* openWork(w);
        yield* readUntil("the late step", () =>
          tags(w, "content.delta").some((event) => event.delta === "Late words."),
        );
      }),
    ));

  it("keeps reading while only a subagent's turn is open, however long that lasts", () =>
    run(
      Effect.gen(function* () {
        const w = yield* startWatching();
        yield* openWork(w);
        registerSubagent(w.home);
        appendChildSteps(w.home, 0, 2);
        yield* readUntil("the start of the subagent's turn", childStarted(w));
        w.setSessionWorkOpen(false);

        // The 2 seconds after the session's work are over, but the subagent's turn is still open.
        yield* runOutClock(Duration.seconds(5));
        appendChildSteps(w.home, 2, 7);
        yield* readUntil("the end of the subagent's turn", childEnded(w, "completed"));

        expect(summarizeChildTurns(w)).toEqual(["started", "ended completed"]);
      }),
    ));

  it("keeps reading after the tail while a subagent that has steps waits for its launch message, and warns once its wait ran out", () =>
    run(
      Effect.gen(function* () {
        const w = yield* startWatching();
        yield* openWork(w);
        yield* Effect.promise(settle);
        w.setSessionWorkOpen(false);

        // The child is seen late in the 2 second tail, so the tail ends before its own 2 second wait.
        yield* TestClock.adjust(Duration.millis(1900));
        yield* Effect.promise(settle);
        registerSubagent(w.home);
        rmSync(join(folderOf(w.home, CHILD), "messages"), { recursive: true, force: true });
        appendChildSteps(w.home, 0, 2);
        yield* readUntil("the warning about the subagent", () =>
          tags(w, "runtime.warning").some((event) => event.message.includes(CHILD)),
        );
      }),
    ));

  it("shows a step of the session's own transcript to the running Turn as a fact, and shows nothing itself", () =>
    run(
      Effect.gen(function* () {
        const w = yield* startWatching();
        yield* openWork(w);
        mkdirSync(dirname(transcriptOf(w.home, ROOT)), { recursive: true });
        writeFileSync(
          transcriptOf(w.home, ROOT),
          `${JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "go" })}\n`,
        );
        yield* readUntil("the fact", () => w.facts.length > 0);

        expect(w.facts).toEqual([{ kind: "input" }]);
        expect(w.published).toEqual([]);
      }),
    ));
});

describe("what the watcher shows of a subagent", () => {
  it("shows a subagent before its first turn, and adds the tokens of its model steps to the session's usage", () =>
    run(
      Effect.gen(function* () {
        const w = yield* startWatching();
        yield* openWork(w);
        registerSubagent(w.home);
        appendChildSteps(w.home, 0, 7);
        yield* readUntil("the end of the subagent's turn", childEnded(w, "completed"));

        expect(tags(w, "subagent.started")).toMatchObject([
          { subagentId: CHILD, description: "File Writer", agentType: "self" },
        ]);
        const startedAt = w.published.findIndex((event) => event._tag === "subagent.started");
        const turnAt = w.published.findIndex(
          (event) => event._tag === "turn.started" && isChild(event),
        );
        expect(startedAt).toBeLessThan(turnAt);
        expect(
          tags(w, "session.usage.updated")
            .filter((event) => !isChild(event))
            .at(-1),
        ).toMatchObject({
          usage: { inputTokens: 6801, outputTokens: 329, cacheReadTokens: 21169 },
        });
      }),
    ));

  it("skips what the files held before a resume, and shows a known subagent again only when it writes a new step", () =>
    run(
      Effect.gen(function* () {
        const w = yield* startWatching({
          resumes: true,
          known: [{ subagentId: CHILD }],
          prepare: (home) => {
            registerSubagent(home);
            appendChildSteps(home, 0, 7);
          },
        });
        yield* openWork(w);
        yield* runOutClock(Duration.seconds(1));
        expect(w.published).toEqual([]);

        appendFileSync(transcriptOf(w.home, CHILD), `${LATE_STEP}\n`);
        yield* readUntil("the late step", () =>
          tags(w, "content.delta").some((event) => event.delta === "Late words."),
        );

        expect(tags(w, "subagent.started")).toMatchObject([{ subagentId: CHILD }]);
        expect(
          tags(w, "content.delta").filter((event) => event.delta === "Late words."),
        ).toHaveLength(1);
      }),
    ));
});

describe("files that cannot be read", () => {
  it("warns once when the session's own files cannot be read, counts the usage as incomplete, and shows no subagent after it", () =>
    run(
      Effect.gen(function* () {
        const w = yield* startWatching({
          prepare: (home) => {
            mkdirSync(dirname(transcriptOf(home, ROOT)), { recursive: true });
            writeFileSync(transcriptOf(home, ROOT), "this is not json\n");
          },
        });
        yield* openWork(w);
        yield* readUntil("the warning", () => tags(w, "runtime.warning").length > 0);
        yield* runOutClock(Duration.seconds(1));

        const [warning, ...more] = tags(w, "runtime.warning");
        expect(more).toEqual([]);
        expect(warning?.message).toMatch(
          /^Hercule cannot read Antigravity's session files \(.+\), so subagents' work is not shown and their tokens are not counted\.$/,
        );
        expect(tags(w, "session.usage.updated").at(-1)).toMatchObject({
          usageReport: { status: "incomplete" },
        });

        // The reader is closed for the rest of the process.
        registerSubagent(w.home);
        appendChildSteps(w.home, 0, 7);
        yield* runOutClock(Duration.seconds(1));
        expect(tags(w, "subagent.started")).toEqual([]);
      }),
    ));

  it("ends the open turn of a known subagent as failed, and reports the usage incomplete, when the session's own files become unreadable", () =>
    run(
      Effect.gen(function* () {
        const w = yield* startWatching();
        yield* openWork(w);
        registerSubagent(w.home);
        appendChildSteps(w.home, 0, 2);
        yield* readUntil("the start of the subagent's turn", childStarted(w));

        appendFileSync(transcriptOf(w.home, ROOT), "this is not json\n");
        yield* readUntil("the end of the subagent's turn", childEnded(w, "failed"));

        expect(summarizeChildTurns(w)).toEqual(["started", "ended failed"]);
        expect(tags(w, "runtime.warning")).toHaveLength(1);
        expect(tags(w, "session.usage.updated").at(-1)).toMatchObject({
          usageReport: { status: "incomplete" },
        });
      }),
    ));

  it("ends the turn of a subagent whose files cannot be read as failed, and warns once naming it", () =>
    run(
      Effect.gen(function* () {
        const w = yield* startWatching();
        yield* openWork(w);
        registerSubagent(w.home);
        appendChildSteps(w.home, 0, 2);
        yield* readUntil("the start of the subagent's turn", childStarted(w));

        appendFileSync(transcriptOf(w.home, CHILD), "this is not json\n");
        yield* readUntil("the warning", () => tags(w, "runtime.warning").length > 0);
        yield* runOutClock(Duration.seconds(1));

        const [warning, ...more] = tags(w, "runtime.warning");
        expect(more).toEqual([]);
        expect(warning?.message).toContain(CHILD);
        expect(summarizeChildTurns(w)).toEqual(["started", "ended failed"]);
        expect(tags(w, "session.usage.updated").at(-1)).toMatchObject({
          usageReport: { status: "incomplete" },
        });
      }),
    ));
});

describe("a Turn that replied", () => {
  /** Opens the session's work, lets it close, and tells the watcher that a Turn replied. */
  const replyAndClose = (w: Watching) =>
    Effect.gen(function* () {
      yield* openWork(w);
      yield* Effect.promise(settle);
      w.setSessionWorkOpen(false);
      w.watch.recordSessionReply();
    });

  it("warns once, and stops reading the session's own files, when agy wrote no transcript for the conversation", () =>
    run(
      Effect.gen(function* () {
        const w = yield* startWatching();
        yield* replyAndClose(w);
        yield* runOutClock(Duration.seconds(1));
        expect(tags(w, "runtime.warning"), "not before the files had their 2 seconds").toEqual([]);

        yield* readUntil("the warning", () => tags(w, "runtime.warning").length > 0);
        yield* runOutClock(Duration.seconds(10));

        const [warning, ...more] = tags(w, "runtime.warning");
        expect(more).toEqual([]);
        expect(warning?.message).toBe(
          "Hercule cannot read Antigravity's session files (agy wrote no transcript for this conversation), so subagents' work is not shown and their tokens are not counted.",
        );
        expect(tags(w, "session.usage.updated").at(-1)).toMatchObject({
          usageReport: { status: "incomplete" },
        });
      }),
    ));

  it("does not warn when a step of the session's own transcript was shown", () =>
    run(
      Effect.gen(function* () {
        const w = yield* startWatching({
          prepare: (home) => {
            registerSubagent(home);
          },
        });
        yield* replyAndClose(w);
        yield* runOutClock(Duration.seconds(5));

        expect(tags(w, "runtime.warning")).toEqual([]);
      }),
    ));
});

describe("settling after a cancel", () => {
  it("shows the steps a subagent wrote before the cancel, and then ends its open turn as interrupted", () =>
    run(
      Effect.gen(function* () {
        const w = yield* startWatching();
        yield* openWork(w);
        registerSubagent(w.home);
        appendChildSteps(w.home, 0, 2);
        yield* readUntil("the start of the subagent's turn", childStarted(w));
        // Written before the cancel and not read yet.
        appendChildSteps(w.home, 2, 5);

        const settling = yield* Effect.forkChild(w.watch.settleAfterCancel);
        yield* Effect.promise(settle);
        yield* TestClock.adjust(Duration.millis(250));
        yield* Fiber.join(settling);

        expect(summarizeChildTurns(w)).toEqual(["started", "ended interrupted"]);
        const commandAt = w.published.findIndex(
          (event) =>
            isChild(event) &&
            event._tag === "item.completed" &&
            event.kind === "command_execution" &&
            event.status === "completed",
        );
        const endAt = w.published.findIndex(
          (event) => isChild(event) && event._tag === "turn.completed",
        );
        expect(commandAt, "the step was shown").toBeGreaterThan(-1);
        expect(commandAt).toBeLessThan(endAt);
        expect(w.watch.hasOpenSubagentTurn()).toBe(false);
      }),
    ));

  it("waits for the files to catch up, so a step that reaches its file just after the cancel is shown before the turn ends", () =>
    run(
      Effect.gen(function* () {
        const w = yield* startWatching();
        yield* openWork(w);
        registerSubagent(w.home);
        appendChildSteps(w.home, 0, 2);
        yield* readUntil("the start of the subagent's turn", childStarted(w));

        const settling = yield* Effect.forkChild(w.watch.settleAfterCancel);
        yield* Effect.promise(settle);
        // `agy` wrote this step before the cancel, but it reaches the file only now, inside the lag.
        appendChildSteps(w.home, 2, 5);
        yield* TestClock.adjust(Duration.millis(250));
        yield* Fiber.join(settling);

        const commandAt = w.published.findIndex(
          (event) =>
            isChild(event) && event._tag === "item.completed" && event.kind === "command_execution",
        );
        expect(commandAt, "the step was shown").toBeGreaterThan(-1);
        expect(summarizeChildTurns(w)).toEqual(["started", "ended interrupted"]);
      }),
    ));

  it("does not wait for the lag when no subagent has a turn open", () =>
    run(
      Effect.gen(function* () {
        const w = yield* startWatching();

        // The test clock never moves, so waiting for the lag would never end.
        yield* w.watch.settleAfterCancel;

        expect(w.published).toEqual([]);
      }),
    ));
});
