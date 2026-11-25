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
import {
  answerWith,
  readRecording,
  startFakeHarness,
  type FakeHarness,
  type HarnessScript,
} from "@hercule/acp/testing";
import type { HarnessRunnerContext } from "../index";
import type { Run } from "../process";
import { createScratchHome } from "../testing";
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

/** What a worker of a process that uses the account's own login writes in its log. */
const FILE_STORAGE_LINE =
  'level=info msg="Using file-based token storage because SSH session detected"';

/** Returns the context of a runner for the account in `home`. */
export const buildContext = (home: string, binary: string = BINARY): HarnessRunnerContext => ({
  cwd: null,
  home,
  binary,
  env: { PATH: "/usr/bin" },
  modelArgument: "{model}",
  credentialVariables: [],
  herculeTool: { orientation: "", skill: "", claudePluginDir: join(home, "claude-plugin") },
  attachmentsDir: null,
  editMarks: null,
  attachmentUploader: { upload: () => Effect.die("a probe uploads nothing") },
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

/** The recording's reply to `session/new`, with the conversation's own id. */
const readRecordedNewSession = (id: string): Record<string, unknown> => {
  const reply = readRecording("cancel").find(
    ({ direction, message }) =>
      direction === "in" &&
      typeof message.result === "object" &&
      message.result !== null &&
      "sessionId" in message.result,
  );
  return { ...(reply!.message.result as Record<string, unknown>), sessionId: id };
};

/**
 * Returns a script for `session/new` that creates the conversation's files in
 * `home` first, as `agy` does, and then answers with the recording's models.
 */
export const answerNewSession =
  (home: string, id: string = CONVERSATION): HarnessScript =>
  (call, harness) => {
    createConversationFiles(home, id);
    return answerWith(readRecordedNewSession(id))(call, harness);
  };

export interface Spawned {
  readonly command: ReadonlyArray<string>;
  readonly cwd: string;
  readonly harness: FakeHarness;
  /** The signals the runner sent, in order. */
  readonly signals: Array<string | undefined>;
  hasExited: boolean;
  /** What was in the Harness Home at the moment the process exited. */
  filesAtExit: ReadonlyArray<string> | undefined;
}

export interface FakeAgy {
  readonly spawn: AgySpawn;
  readonly spawns: Array<Spawned>;
  /** The commands the fake ran for `Run`, such as `agy --version`. */
  readonly ran: Array<ReadonlyArray<string>>;
  readonly run: Run;
}

/**
 * Builds a fake `agy` for the Harness Home `home`. Its process answers from
 * the recording, with `session/new` and `session/close` answered as `agy`
 * does unless `scripts` says otherwise. A spawn writes the logs of a process
 * that uses file storage next to the path of `--log-file`.
 */
export const buildFakeAgy = (
  home: string,
  options: { readonly scripts?: Readonly<Record<string, HarnessScript>> } = {},
): FakeAgy => {
  const scripts = {
    "session/new": answerNewSession(home),
    "session/close": answerWith({}),
    ...options.scripts,
  };
  const spawns: Array<Spawned> = [];
  const ran: Array<ReadonlyArray<string>> = [];
  const spawn: AgySpawn = (command, _env, cwd) => {
    const logFile = command[command.indexOf("--log-file") + 1]!;
    writeFileSync(logFile, "");
    writeFileSync(`${logFile}.4000`, FILE_STORAGE_LINE);
    const harness = startFakeHarness({ recording: readRecording("cancel"), scripts });
    const signals: Array<string | undefined> = [];
    const spawned: Spawned = {
      command,
      cwd,
      harness,
      signals,
      hasExited: false,
      filesAtExit: undefined,
    };
    void harness.exited.then(() => {
      spawned.hasExited = true;
      spawned.filesAtExit = existsSync(home) ? listHomeFiles(home) : [];
    });
    spawns.push(spawned);
    return {
      write: harness.write,
      stdout: harness.stdout,
      stderr: harness.stderr,
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
    return Effect.succeed({ code: 0, stdout: `${AGY_VERSION}\n`, stderr: "" });
  };
  return { spawn, spawns, ran, run };
};
