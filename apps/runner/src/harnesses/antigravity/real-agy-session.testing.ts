/**
 * Starts the real `agy` through the Antigravity adapter's own `startSession`,
 * on a lent Google login, and gives a test what it needs to drive a session:
 * send an input, answer an approval, wait for a turn to end, and read the
 * events. The suite of the MCP Gateway,
 * `apps/controller/src/http/mcp-antigravity.integration.test.ts`, uses it.
 *
 * A real model answers, so a test that uses this helper spends the account's
 * quota. It needs both of these, and `findRealAgySkipReason` says which is
 * missing:
 *
 * - `agy`: `HERCULE_AGY_TEST_BINARY`, or `agy` on the `PATH`.
 * - `HERCULE_AGY_TEST_LOGIN`: the path of an `antigravity-oauth-token` file
 *   that a person lends. The file is copied unread into a scratch Harness Home
 *   with mode 0600, and never printed.
 *
 * Every process gets an environment built from nothing (a scratch `HOME` and a
 * short `PATH`). The binary is copied into a scratch folder and only the copy
 * runs, because `agy` can replace its own binary. The scratch folders are made
 * under the developer's home folder and not under `/tmp`, because `agy`
 * treats `/tmp` as a place that is always safe to write (spec 06 section 8.1).
 */
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { MCP_GATEWAY_ENTRY_NAME } from "@hercule/protocol";
import type {
  ApprovalDecision,
  ExitReason,
  HarnessEvent,
  ModelDescriptor,
  SessionSpec,
} from "@hercule/protocol";
import { SESSION_TOKEN_VARIABLE } from "../../credentials/helper";
import type { HarnessAdapter } from "../index";
import { runProcess, spawnAgy } from "../process";
import { makeAntigravityAdapter } from "./adapter";
import { findAgyTestBinary } from "./agy-binary.testing";
import { buildContext } from "./fake-agy.testing";
import { APP_DATA_DIR } from "./harness-home";

type Event<Tag extends HarnessEvent["_tag"]> = Extract<HarnessEvent, { _tag: Tag }>;

/** A request the session opened. */
export type OpenedRequest = Event<"request.opened">["request"];

/** How long one wait for something from `agy` lasts. A real model answers, so this is generous. */
export const WAIT_MS = 100_000;

/** The most one whole test takes, with room for several turns of a real model. */
export const REAL_AGY_TEST_MS = 240_000;

/**
 * The words that start the real `hercule antigravity-pre-tool-hook` from
 * source, for the adapter's `hookLauncher`. Under vitest the running
 * executable is not the dispatcher, so the default launcher would start
 * nothing useful.
 */
export const REAL_HOOK_LAUNCHER: ReadonlyArray<string> = [
  process.execPath,
  join(dirname(fileURLToPath(import.meta.url)), "../../../../../packages/hercule/src/main.ts"),
];

/**
 * Returns why a test with the real `agy` cannot run here, or `undefined` when
 * it can. A test suite passes this to `describe.skipIf` and puts it in its title.
 */
export const findRealAgySkipReason = (): string | undefined => {
  if (findAgyTestBinary() === undefined) {
    return "no agy binary (HERCULE_AGY_TEST_BINARY, or agy on PATH)";
  }
  const login = process.env["HERCULE_AGY_TEST_LOGIN"];
  return login === undefined || login === ""
    ? "HERCULE_AGY_TEST_LOGIN is not set: no lent Google login"
    : undefined;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Makes every file and folder below `path` writable by its owner, because `agy` creates some with narrower modes. */
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

/** Picks the account's cheapest model: one with `flash` in its id when listed, else the default, else the first. */
const pickCheapModel = (models: ReadonlyArray<ModelDescriptor>): ModelDescriptor | undefined =>
  models.find((model) => /flash/i.test(model.slug)) ??
  models.find((model) => model.isDefault === true) ??
  models[0];

/** What a test chooses when it starts a session. */
export interface RealAgyStart {
  readonly accessMode: SessionSpec["accessMode"];
  /** The address of the MCP Gateway entry. */
  readonly mcpUrl: string;
  /** The session token, which goes to `agy` in the entry's `Authorization` header. */
  readonly sessionToken: string;
  /** Resumes this conversation, in the work folder of the session that made it. */
  readonly continue?: SessionSpec["continue"];
  /** The work folder. A fresh one when absent. A test that fills it first (a repository's `.agents` folder) makes and removes it itself. */
  readonly cwd?: string;
}

/** A session with the real `agy`. */
export interface RealAgySession {
  /** The Hercule session id the events carry. */
  readonly id: string;
  readonly nativeSessionId: string;
  readonly cwd: string;
  /** Every event of the session so far, oldest first. */
  readonly events: () => ReadonlyArray<HarnessEvent>;
  /** Sends an input and returns the id of its turn. */
  readonly sendInput: (text: string) => Promise<string>;
  /** Waits until `find` returns a value for the session's events, and returns it. The failure lists what `agy` did. */
  readonly waitFor: <T>(
    what: string,
    find: (events: ReadonlyArray<HarnessEvent>) => T | undefined,
  ) => Promise<T>;
  /** Waits until the turn `turnId` has ended, and returns its end. */
  readonly waitForTurnEnd: (turnId: string) => Promise<Event<"turn.completed">>;
  readonly answer: (request: OpenedRequest, decision: ApprovalDecision) => Promise<void>;
  /**
   * Sends `text` and answers each approval the turn opens with `decide`
   * (allow when absent), until the turn ends. Returns the events from the
   * input to the end of the turn.
   */
  readonly runTurn: (
    text: string,
    decide?: (request: OpenedRequest) => ApprovalDecision,
  ) => Promise<{
    readonly events: ReadonlyArray<HarnessEvent>;
    readonly end: Event<"turn.completed">;
  }>;
  /** Lists what `agy` did in the session, for a failure message. */
  readonly describe: () => string;
  readonly stop: (reason: ExitReason) => Promise<void>;
}

/** The parts of the real `agy` that all sessions of a suite share. */
export interface RealAgyRig {
  readonly startSession: (start: RealAgyStart) => Promise<RealAgySession>;
  /** Stops every session that is still running and deletes the scratch folders. */
  readonly dispose: () => Promise<void>;
}

/**
 * Prepares the real `agy` for a suite: copies the binary and the login into
 * scratch folders, starts collecting the adapter's events, and probes the
 * account. Fails when the lent login is not signed in.
 */
export const prepareRealAgy = async (): Promise<RealAgyRig> => {
  const pinnedBinary = findAgyTestBinary();
  const loginFile = process.env["HERCULE_AGY_TEST_LOGIN"];
  if (pinnedBinary === undefined || loginFile === undefined || loginFile === "") {
    throw new Error("prepareRealAgy needs a binary and a lent login: check findRealAgySkipReason.");
  }
  const adapter: HarnessAdapter = makeAntigravityAdapter({
    spawn: spawnAgy,
    run: runProcess,
    hookLauncher: REAL_HOOK_LAUNCHER,
  });
  const scratchFolders: Array<string> = [];
  const makeScratchFolder = (label: string): string => {
    const base = join(homedir(), ".cache");
    mkdirSync(base, { recursive: true });
    const folder = mkdtempSync(join(base, `hercule-agy-mcp-${label}-`));
    scratchFolders.push(folder);
    return folder;
  };

  const eventsBySession = new Map<string, Array<HarnessEvent>>();
  let collector: Fiber.Fiber<void, unknown> | undefined;

  const dispose = async (): Promise<void> => {
    for (const id of eventsBySession.keys()) {
      await Effect.runPromise(adapter.stopSession(id, "stopped")).catch(() => undefined);
    }
    if (collector !== undefined) await Effect.runPromise(Fiber.interrupt(collector));
    for (const folder of scratchFolders.splice(0)) {
      makeTreeWritable(folder);
      rmSync(folder, { recursive: true, force: true });
    }
  };

  // A run that is killed still removes the copy of the lent login when its process exits.
  process.once("exit", () => {
    for (const folder of scratchFolders) {
      makeTreeWritable(folder);
      rmSync(folder, { recursive: true, force: true });
    }
  });

  // The folders exist from the first line of the setup, so a failure anywhere in it must remove them.
  try {
    const binaryPath = join(makeScratchFolder("binary"), "agy");
    copyFileSync(pinnedBinary, binaryPath);
    chmodSync(binaryPath, 0o755);
    const userHome = makeScratchFolder("home");
    const harnessHome = makeScratchFolder("harness-home");
    chmodSync(harnessHome, 0o700);
    mkdirSync(join(harnessHome, APP_DATA_DIR), { recursive: true });
    writeFileSync(
      join(harnessHome, APP_DATA_DIR, "antigravity-oauth-token"),
      readFileSync(loginFile),
      { mode: 0o600 },
    );
    const baseEnvironment: Record<string, string> = {
      HOME: userHome,
      PATH: "/usr/bin:/bin",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent",
    };

    collector = Effect.runFork(
      Stream.runForEach(adapter.events, (event) =>
        Effect.sync(() => eventsBySession.get(event.sessionId)?.push(event)),
      ),
    );

    const probed = await Effect.runPromise(
      adapter.probe(buildContext(harnessHome, binaryPath, baseEnvironment), { readUsage: false }),
    );
    if (probed.auth.status !== "ok") {
      throw new Error(
        `The lent login is not signed in: the probe reported "${probed.auth.status}". Lend the token of a signed-in Harness Home.`,
      );
    }
    const cheapModel = pickCheapModel(probed.models)?.slug;
    if (cheapModel === undefined) throw new Error("The account lists no model.");

    const startSession = async (start: RealAgyStart): Promise<RealAgySession> => {
      const id = crypto.randomUUID();
      const cwd = start.cwd ?? makeScratchFolder("work");
      const seen: Array<HarnessEvent> = [];
      eventsBySession.set(id, seen);
      const spec: SessionSpec = {
        providerAccountId: "0199e0e7-0000-7000-8000-0000000000aa",
        workspaceId: null,
        modelSelection: { model: cheapModel, options: {} },
        accessMode: start.accessMode,
        timeouts: { inactivityMs: 1_800_000, absoluteMs: 28_800_000 },
        ...(start.continue === undefined ? {} : { continue: start.continue }),
      };
      const binding = await Effect.runPromise(
        adapter.startSession(id, spec, {
          ...buildContext(harnessHome, binaryPath, {
            ...baseEnvironment,
            [SESSION_TOKEN_VARIABLE]: start.sessionToken,
          }),
          cwd,
          mcpServers: [{ name: MCP_GATEWAY_ENTRY_NAME, url: start.mcpUrl }],
        }),
      );

      const describe = (): string => {
        const lines = seen.map((event) => {
          switch (event._tag) {
            case "item.started":
            case "item.updated":
              return `${event._tag}(${event.kind})`;
            case "item.completed":
              return `item.completed(${event.kind}, ${event.status})`;
            case "turn.completed":
              return `turn.completed(${event.state})`;
            case "request.opened":
              return `request.opened(${event.request.kind})`;
            case "runtime.error":
              return `runtime.error(${event.message ?? ""})`;
            default:
              return event._tag;
          }
        });
        return `What agy did in the session, in order:\n  ${lines.join("\n  ")}`;
      };
      const waitFor: RealAgySession["waitFor"] = async (what, find) => {
        const deadline = Date.now() + WAIT_MS;
        for (;;) {
          const found = find(seen);
          if (found !== undefined) return found;
          if (Date.now() > deadline) {
            throw new Error(`agy never ${what} within ${String(WAIT_MS)} ms.\n${describe()}`);
          }
          await sleep(25);
        }
      };
      const waitForTurnEnd = (turnId: string) =>
        waitFor(`ended the turn ${turnId}`, (events) =>
          events.find(
            (event): event is Event<"turn.completed"> =>
              event._tag === "turn.completed" && event.turnId === turnId,
          ),
        );
      const answer: RealAgySession["answer"] = (request, decision) =>
        Effect.runPromise(adapter.respondToApprovalRequest(id, request.requestId, decision));
      const sendInput: RealAgySession["sendInput"] = async (text) =>
        (await Effect.runPromise(adapter.sendInput(id, { text }))).turnId;
      return {
        id,
        nativeSessionId: binding.nativeSessionId,
        cwd,
        events: () => seen,
        sendInput,
        waitFor,
        waitForTurnEnd,
        answer,
        runTurn: async (text, decide) => {
          const mark = seen.length;
          const turnId = await sendInput(text);
          const decided = new Set<string>();
          const end = await waitFor(`ended the turn of "${text}"`, (events) => {
            for (const event of events.slice(mark)) {
              if (event._tag !== "request.opened" || event.request.kind === "question") continue;
              if (decided.has(event.request.requestId)) continue;
              decided.add(event.request.requestId);
              void answer(event.request, decide?.(event.request) ?? "allow");
            }
            return events.find(
              (one): one is Event<"turn.completed"> =>
                one._tag === "turn.completed" && one.turnId === turnId,
            );
          });
          return { events: seen.slice(mark), end };
        },
        describe,
        stop: (reason) => Effect.runPromise(adapter.stopSession(id, reason)),
      };
    };
    return { startSession, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
};
