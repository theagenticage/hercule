/**
 * The Antigravity adapter. Today it can probe the account, sign in, install
 * `agy` and delete the files of a conversation. It runs no session yet: the
 * methods of a session fail with one clear message, and its streams are
 * empty.
 */
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import {
  buildAdapterFailed,
  buildAnswerNotDelivered,
  buildSessionNotRunning,
} from "../adapter-error-builders";
import type { HarnessAdapter } from "../index";
import { buildFailedProbe } from "../probe";
import { runProcess, spawnAgy } from "../process";
import { buildLoginCommand, type AgySeam } from "./agy";
import { deleteSessionFiles } from "./harness-home";
import { ANTIGRAVITY_NAME } from "./harness-name";
import { makeAntigravityInstall } from "./install";
import { makeProbe } from "./probe";

/** The harness id: the plugin's id, then the harness's own id in it. */
export const ANTIGRAVITY = "antigravity/antigravity";

const ANTIGRAVITY_BINARY = "agy";

/**
 * Builds the Antigravity adapter on `seam`. Tests pass a fake `agy` process
 * and a fake command runner.
 */
export const makeAntigravityAdapter = (seam: AgySeam): HarnessAdapter => {
  const probe = makeProbe(seam);
  return {
    harnessId: ANTIGRAVITY,
    harnessName: ANTIGRAVITY_NAME,
    binaryName: ANTIGRAVITY_BINARY,

    events: Stream.empty,
    usageReports: Stream.empty,

    // The probe ignores `options.readUsage`: `agy` has no usage read.
    probe: (ctx) =>
      ctx.binary === undefined
        ? Effect.succeed(buildFailedProbe(null, `no ${ANTIGRAVITY_BINARY} on this machine`))
        : probe(ctx, ctx.binary),

    // This build runs no Antigravity sessions, so no caller can wait for one.
    startSession: () =>
      Effect.fail(
        buildAdapterFailed(`This version of Hercule cannot run ${ANTIGRAVITY_NAME} sessions yet`),
      ),
    sendInput: () => Effect.fail(buildSessionNotRunning()),
    respondToQuestion: () =>
      Effect.fail(buildAnswerNotDelivered("This session is not running on this runner")),
    interrupt: () => Effect.void,
    respondToApprovalRequest: () => Effect.void,
    stopSession: () => Effect.void,
    listSessions: Effect.succeed([]),

    deleteSessionFiles,

    generateText: () =>
      Effect.fail(
        `${ANTIGRAVITY_NAME} runs no text generations. Pick another model for it in Settings.`,
      ),

    login: (ctx, binary, method) =>
      method === "sign-in" ? buildLoginCommand(ctx, binary) : undefined,

    install: makeAntigravityInstall(seam.run),
  };
};

export const antigravity: HarnessAdapter = makeAntigravityAdapter({
  spawn: spawnAgy,
  run: runProcess,
});
