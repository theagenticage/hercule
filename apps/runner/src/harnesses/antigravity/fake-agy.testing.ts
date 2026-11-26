/**
 * A fake `agy` for the tests of the probe and the adapter. It answers over the
 * pipes of a real process, from the recording of a signed-in account, and it
 * writes what a real `agy` writes in the Harness Home: the worker log that
 * shows the process uses the account's own login, and the files of a
 * conversation when `session/new` is answered. The real `agy` is never
 * started.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import type { AcpHandlers } from "@hercule/acp";
import {
  answerWith,
  readRecording,
  startFakeHarness,
  type FakeHarness,
  type HarnessScript,
  type RecordedMessage,
  type RecordingName,
} from "@hercule/acp/testing";
import type { HarnessRunnerContext } from "../index";
import type { Run } from "../process";
import { createLines, createScratchHome, NO_CONTROLLER_UPLOADER } from "../testing";
import type { AgySpawn } from "./agy";
import { APP_DATA_DIR } from "./harness-home";

export const BINARY = "/opt/agy/agy";

/** The email in the token file of a home made by `createSignedInHome`. */
export const SIGNED_IN_EMAIL = "ana@example.com";

/** The plan name in the recording's reply to `authenticate`. */
export const PLAN_LABEL = "Antigravity Starter Quota";

/** The version `agy --version` prints in the fake. */
export const AGY_VERSION = "1.5.15";

/** The conversation id in the recording's reply to `session/new`. */
export const CONVERSATION = "558eccc9-5c63-48a1-bf9f-14edaf5a58a5";

const tokenPath = (home: string): string => join(home, APP_DATA_DIR, "antigravity-oauth-token");

/** What a worker of a process that uses the account's own login writes in its log (a line of a real `agy`). */
export const FILE_STORAGE_LINE =
  "I1125 16:54:06.115838      87 composite_token_storage.go:176] Using file-based token storage because SSH session detected";

/** What a worker writes when it kept looking for the login in the keychain. */
export const KEYRING_LINE =
  "W1126 10:00:00.000000    4000 token_store.go:38] Failed to load stored token from keyring, falling back to file";

/** What a worker writes when it could not reach Google to check an expired login (a line of a real `agy`). */
export const NETWORK_ERROR_LINE =
  'W1125 16:54:07.765336     286 keyring.go:74] keyringAuth: token validation failed due to network error (token may still be valid): Post "https://oauth2.googleapis.com/token": proxyconnect tcp: dial tcp 127.0.0.1:9: connect: connection refused';

/** What a worker writes when Google's reply says it holds the account for verification. */
export const HELD_BY_GOOGLE_LINE =
  'W1126 10:00:00.000000    4000 api.go:90] googleapi: Error 403: {"error": {"reason": "VALIDATION_REQUIRED"}}';

/** Handlers for a connection in a test that expects nothing from `agy` but answers. */
export const NO_HANDLERS: AcpHandlers = {
  onSessionUpdate: () => undefined,
  onApprovalRequest: () => Effect.succeed({ outcome: "cancelled" }),
  onElicitation: () => Effect.succeed({ action: "cancel" }),
  onUnhandledMessage: () => undefined,
};

/** Returns the context of a runner for the account in `home`. */
export const buildContext = (
  home: string,
  binary: string = BINARY,
  env: HarnessRunnerContext["env"] = { PATH: "/usr/bin" },
): HarnessRunnerContext => ({
  cwd: null,
  home,
  binary,
  env,
  modelArgument: "{model}",
  credentialVariables: [],
  herculeTool: { orientation: "", skill: "", claudePluginDir: join(home, "claude-plugin") },
  attachmentsDir: null,
  editMarks: null,
  attachmentUploader: NO_CONTROLLER_UPLOADER,
});

/** Writes the token file of `agy` with `email`, or with no email field when it is `undefined`. */
export const writeToken = (home: string, email: string | undefined): void => {
  mkdirSync(join(home, APP_DATA_DIR), { recursive: true });
  writeFileSync(
    tokenPath(home),
    JSON.stringify({
      token: { access_token: "secret-access", refresh_token: "secret-refresh" },
      auth_method: "oauth",
      ...(email === undefined ? {} : { id_token_email: email }),
    }),
  );
};

/** Makes the Harness Home of an account that signed in as `email`. */
export const createSignedInHome = (email: string = SIGNED_IN_EMAIL): string => {
  const home = createScratchHome("agy-probe");
  writeToken(home, email);
  return home;
};

/** Writes the files `agy` keeps for the conversation `id`: its database and its `brain` folder. */
export const createConversationFiles = (home: string, id: string): void => {
  const appData = join(home, APP_DATA_DIR);
  mkdirSync(join(appData, "conversations"), { recursive: true });
  mkdirSync(join(appData, "brain", id), { recursive: true });
  writeFileSync(join(appData, "conversations", `${id}.db`), "database");
  writeFileSync(join(appData, "brain", id, "plan.md"), "plan");
};

/** Lists every file and folder below `home`, sorted, so a test can compare two states of the home. */
export const listHomeFiles = (home: string): ReadonlyArray<string> =>
  readdirSync(home, { recursive: true, encoding: "utf8" }).sort();

/** Returns a script that refuses the call with a JSON-RPC error. */
export const refuse =
  (code: number, message: string): HarnessScript =>
  ({ id }) => [{ jsonrpc: "2.0", id, error: { code, message } }];

/** A script for a call the process never answers. */
export const noAnswer: HarnessScript = () => [];

/** The recording's reply to the call `method`, which a signed-in account got. */
const readRecordedResult = (method: string): unknown => {
  const recording = readRecording("cancel");
  const asked = recording.findIndex(
    ({ direction, message }) => direction === "out" && message.method === method,
  );
  return recording.slice(asked + 1).find(({ direction }) => direction === "in")!.message.result;
};

/** The recording's reply to `session/new`. It holds the conversation's own id, models, modes and config options. */
const readRecordedNewSession = (name: RecordingName): Record<string, unknown> =>
  readRecording(name).find(
    ({ direction, message }) =>
      direction === "in" &&
      typeof message.result === "object" &&
      message.result !== null &&
      "sessionId" in message.result,
  )!.message.result as Record<string, unknown>;

/**
 * Returns the id of the conversation a recording ran. The updates and requests
 * of the recording name it, so a session over that recording must be given
 * the same id.
 */
export const readRecordedConversation = (name: RecordingName): string =>
  readRecordedNewSession(name)["sessionId"] as string;

/**
 * Returns the messages of a recording before its first prompt: the handshake
 * and the opening of the conversation. A fake over them answers a prompt only
 * with the script a test gives it, so the test decides how a turn goes.
 */
export const readRecordedSetup = (name: RecordingName): ReadonlyArray<RecordedMessage> => {
  const recording = readRecording(name);
  const firstPrompt = recording.findIndex(
    ({ direction, message }) => direction === "out" && message.method === "session/prompt",
  );
  return recording.slice(0, firstPrompt);
};

/** A reply to `session/new` with the recording's models, modes and options for the conversation `id`. */
const buildNewSessionReply = (name: RecordingName, id: string): Record<string, unknown> => ({
  ...readRecordedNewSession(name),
  sessionId: id,
});

/**
 * Returns a script for `session/resume`. Like `agy`, it answers with the
 * recording's models when the conversation's files exist in `home`, and
 * otherwise refuses with the error `agy` gives for an id it does not know.
 */
export const answerResume =
  (home: string, name: RecordingName = "cancel"): HarnessScript =>
  (call, harness) => {
    const id = (call.params as { sessionId: string }).sessionId;
    return existsSync(join(home, APP_DATA_DIR, "conversations", `${id}.db`))
      ? answerWith(buildNewSessionReply(name, id))(call, harness)
      : refuse(-32603, `Failed to read session ${id}; retry, or load it with session/load`)(
          call,
          harness,
        );
  };

/**
 * Returns a script for `session/new` that creates the conversation's files in
 * `home` first, as `agy` does, and then answers with the recording's models.
 */
export const answerNewSession =
  (home: string, id: string = CONVERSATION, name: RecordingName = "cancel"): HarnessScript =>
  (call, harness) => {
    createConversationFiles(home, id);
    return answerWith(buildNewSessionReply(name, id))(call, harness);
  };

/**
 * Returns a script for `session/set_config_option` that accepts the change and
 * answers with the recording's config options, the changed one holding its new
 * value, as `agy` does.
 */
export const answerConfigChange =
  (name: RecordingName): HarnessScript =>
  ({ id, params }) => {
    const { configId, value } = params as { configId: string; value: string };
    const configOptions = (
      readRecordedNewSession(name)["configOptions"] as Array<{ id: string }>
    ).map((option) => (option.id === configId ? { ...option, currentValue: value } : option));
    return [{ jsonrpc: "2.0", id, result: { configOptions } }];
  };

export interface Spawned {
  readonly command: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly harness: FakeHarness;
  /** The signals the runner sent, in order. */
  readonly signals: Array<string | undefined>;
  hasExited: boolean;
}

export interface FakeAgy {
  readonly spawn: AgySpawn;
  readonly spawns: Array<Spawned>;
  /** The commands the fake ran for `Run`, such as `agy --version`. */
  readonly ran: Array<ReadonlyArray<string>>;
  readonly run: Run;
}

/** The calls that make `agy` start a worker process, which writes a log. */
export type WorkerStartingMethod = "authenticate" | "session/new" | "session/resume";

export interface FakeAgyOptions {
  /** Scripts for methods of the process. They win over the defaults. */
  readonly scripts?: Readonly<Record<string, HarnessScript>>;
  /**
   * What the worker started by each call writes in its log, one text per
   * worker. The default for every call is one worker that uses file storage.
   * An empty list is a call that starts no worker.
   */
  readonly workerLogs?: Partial<Record<WorkerStartingMethod, string | ReadonlyArray<string>>>;
  /** The text of the log of the front process. */
  readonly frontLog?: string;
  /** What the process writes on stderr. */
  readonly stderrLines?: ReadonlyArray<string>;
  /** Keeps stderr open after the process exited, as a descendant that holds the pipe does. */
  readonly holdStderrOpen?: boolean;
  /** Makes the spawn throw this, as a binary that cannot be started does. */
  readonly throws?: Error;
  /** What `agy --version` prints. `null` makes the command fail. */
  readonly version?: string | null;
  /** Makes `agy --version` never end. */
  readonly hangVersion?: boolean;
  /**
   * The recording the process plays. The default is `cancel`. A name also
   * decides the conversation's id (`readRecordedConversation`). Pass
   * `readRecordedSetup(name)` for a process that plays no turn, so that a test
   * scripts it by hand.
   */
  readonly recording?: RecordingName | ReadonlyArray<RecordedMessage>;
  /** Leaves `antigravity.systemPrompt.append` out of the reply to `initialize`, as an older `agy` does. */
  readonly withoutSystemPromptCapability?: boolean;
  /** Leaves `sessionCapabilities.additionalDirectories` out of the reply to `initialize`, as an older `agy` does. */
  readonly withoutAdditionalDirectoriesCapability?: boolean;
}

/** Returns the recording without `additionalDirectories` in the session capabilities of the reply to `initialize`. */
const removeAdditionalDirectoriesCapability = (
  recording: ReadonlyArray<RecordedMessage>,
): ReadonlyArray<RecordedMessage> =>
  recording.map((entry) => {
    const result = entry.message.result as
      | { agentCapabilities?: { sessionCapabilities?: Record<string, unknown> } }
      | undefined;
    const capabilities = result?.agentCapabilities;
    if (entry.direction !== "in" || capabilities?.sessionCapabilities === undefined) return entry;
    const sessionCapabilities = { ...capabilities.sessionCapabilities };
    delete sessionCapabilities["additionalDirectories"];
    return {
      ...entry,
      message: {
        ...entry.message,
        result: { ...result, agentCapabilities: { ...capabilities, sessionCapabilities } },
      },
    };
  });

/** Returns the recording without `antigravity.systemPrompt` in the capabilities of the reply to `initialize`. */
const removeSystemPromptCapability = (
  recording: ReadonlyArray<RecordedMessage>,
): ReadonlyArray<RecordedMessage> =>
  recording.map((entry) => {
    const result = entry.message.result as
      | { agentCapabilities?: { _meta?: { antigravity?: object } } }
      | undefined;
    const meta = result?.agentCapabilities?._meta;
    if (entry.direction !== "in" || meta?.antigravity === undefined) return entry;
    const antigravity = { ...(meta.antigravity as Record<string, unknown>) };
    delete antigravity["systemPrompt"];
    return {
      ...entry,
      message: {
        ...entry.message,
        result: {
          ...result,
          agentCapabilities: { ...result!.agentCapabilities, _meta: { ...meta, antigravity } },
        },
      },
    };
  });

/**
 * Builds a fake `agy` for the Harness Home `home`. Its process answers from
 * the recording, with `session/new`, `session/resume` and `session/close`
 * answered as `agy` does unless `scripts` says otherwise. A call that starts a
 * worker (`authenticate`, `session/new`, `session/resume`) writes the worker's
 * log next to the path of `--log-file` before it answers, as `agy` does, so
 * no test writes a log by hand.
 */
export const buildFakeAgy = (home: string, options: FakeAgyOptions = {}): FakeAgy => {
  const { frontLog = "", stderrLines = [] } = options;
  const recordingName: RecordingName =
    options.recording === undefined || typeof options.recording !== "string"
      ? "cancel"
      : options.recording;
  const conversation = readRecordedConversation(recordingName);
  const scripts: Record<string, HarnessScript> = {
    authenticate: answerWith(readRecordedResult("authenticate")),
    "session/new": answerNewSession(home, conversation, recordingName),
    "session/resume": answerResume(home, recordingName),
    "session/close": answerWith({}),
    "session/set_config_option": answerConfigChange(recordingName),
    "session/set_mode": answerWith({}),
    ...options.scripts,
  };
  const spawns: Array<Spawned> = [];
  const ran: Array<ReadonlyArray<string>> = [];
  const spawn: AgySpawn = (command, env, cwd) => {
    if (options.throws !== undefined) throw options.throws;
    const logFile = command[command.indexOf("--log-file") + 1]!;
    writeFileSync(logFile, frontLog);
    let nextPid = 4000;
    const harnessScripts: Record<string, HarnessScript> = { ...scripts };
    for (const method of ["authenticate", "session/new", "session/resume"] as const) {
      const answer = scripts[method]!;
      const texts = options.workerLogs?.[method] ?? FILE_STORAGE_LINE;
      harnessScripts[method] = (call, harness) => {
        for (const text of typeof texts === "string" ? [texts] : texts) {
          writeFileSync(`${logFile}.${nextPid++}`, text);
        }
        return answer(call, harness);
      };
    }
    const stderr = createLines();
    for (const line of stderrLines) stderr.push(line);
    if (options.holdStderrOpen !== true) stderr.end();
    const recording =
      options.recording === undefined || typeof options.recording === "string"
        ? readRecording(recordingName)
        : options.recording;
    const withSystemPrompt =
      options.withoutSystemPromptCapability === true
        ? removeSystemPromptCapability(recording)
        : recording;
    const harness = startFakeHarness({
      recording:
        options.withoutAdditionalDirectoriesCapability === true
          ? removeAdditionalDirectoriesCapability(withSystemPrompt)
          : withSystemPrompt,
      scripts: harnessScripts,
    });
    const signals: Array<string | undefined> = [];
    const spawned: Spawned = { command, env, cwd, harness, signals, hasExited: false };
    void harness.exited.then(() => {
      spawned.hasExited = true;
    });
    spawns.push(spawned);
    return {
      // A checked write returns a promise, like the real one.
      // oxlint-disable-next-line typescript/require-await
      write: async (text) => harness.write(text),
      stdout: harness.stdout,
      stderr: stderr.iterable,
      end: harness.end,
      kill: (signal) => {
        signals.push(signal);
        harness.kill();
      },
      exited: harness.exited,
    };
  };
  const run: Run = (command) => {
    ran.push(command);
    if (options.hangVersion === true) return Effect.never;
    return Effect.succeed(
      options.version === null
        ? { code: 1, stdout: "", stderr: "agy: broken" }
        : { code: 0, stdout: `${options.version ?? AGY_VERSION}\n`, stderr: "" },
    );
  };
  return { spawn, spawns, ran, run };
};
