/**
 * Builds the adapter errors that describe the same situation in every adapter
 * and in the session supervisor. The message of an adapter error is shown to
 * the user as written, so one situation gets one sentence, whichever harness
 * runs the session.
 *
 * `harnessName` is the name the user knows the harness by: "Claude Code",
 * "Codex" or "pi". A `reason` is text from the harness or the operating
 * system. It ends the message, after a lead-in that describes what happened,
 * and the builders cut the message to the protocol's limit because a longer
 * one cannot be put in an error.
 */
import {
  AnswerNotDelivered,
  HarnessNotInstalled,
  HarnessProtocolError,
  InputNotDelivered,
  ModelChangeRefused,
  SessionAlreadyRunning,
  SessionNotRunning,
  AdapterFailed,
} from "@hercule/protocol";
import { endSentence } from "../report";
import { truncateMessage } from "./text";

/** Ends `message` with a period, then cuts it to the protocol's limit. */
const finishMessage = (message: string): string => truncateMessage(endSentence(message));

/**
 * Builds an `AdapterFailed` from a whole message: ends it with a period and
 * cuts it to the protocol's limit. For a failure that no other builder here
 * describes. Every message built in an adapter goes through a builder, because
 * an error with a message over the limit cannot be built at all.
 */
export const buildAdapterFailed = (text: string): AdapterFailed =>
  new AdapterFailed({ message: finishMessage(text) });

/**
 * Builds a `HarnessProtocolError` from a whole message: ends it with a period
 * and cuts it to the protocol's limit. For a failure of the connection to the
 * harness that no other builder here describes.
 */
export const buildHarnessProtocolError = (text: string): HarnessProtocolError =>
  new HarnessProtocolError({ message: finishMessage(text) });

/**
 * Builds the failure of `respondToQuestion` from a whole message: ends it with a
 * period and cuts it to the protocol's limit. The message holds text from the
 * harness, so its length is not known in advance.
 */
export const buildAnswerNotDelivered = (text: string): AnswerNotDelivered =>
  new AnswerNotDelivered({ message: finishMessage(text) });

/** Builds the failure of `startSession` for a runner that has no binary of the harness. */
export const buildHarnessNotInstalled = (harnessName: string): HarnessNotInstalled =>
  new HarnessNotInstalled({ message: `${harnessName} is not installed on this runner.` });

/**
 * Returns the sentence for a harness that could not be started. Used by
 * `buildStartFailure` and by the Codex adapter, whose handshake failure is a
 * `HarnessProtocolError`, not an `AdapterFailed`.
 */
export const describeStartFailure = (harnessName: string, reason: string): string =>
  finishMessage(`${harnessName} could not be started on this runner: ${reason}`);

/** Builds the failure of `startSession` when the harness's process could not be started. */
export const buildStartFailure = (harnessName: string, reason: string): AdapterFailed =>
  new AdapterFailed({ message: describeStartFailure(harnessName, reason) });

/**
 * Builds the failure of `startSession` for a harness whose binary exists but
 * whose process could not be started. When the binary is a script, this is
 * usually because its interpreter, such as node, is not on the PATH of the
 * runner's service, so the message tells the user to check that.
 */
export const buildHarnessNotRunnable = (harnessName: string, reason: string): AdapterFailed =>
  buildAdapterFailed(
    `${harnessName} is installed on this runner but could not be run. If it needs another program, usually node, check that the program is on the PATH of the runner. The error was: ${reason}`,
  );

/** Builds the failure of a call for a session that the runner does not host. */
export const buildSessionNotRunning = (): SessionNotRunning =>
  new SessionNotRunning({ message: "This session is not running on this runner." });

/** Builds the failure of a call for a session whose harness is being stopped. */
export const buildSessionStopping = (): SessionNotRunning =>
  new SessionNotRunning({ message: "This session is stopping on this runner." });

/** Builds the failure of `startSession` for a session the runner already hosts. */
export const buildSessionAlreadyRunning = (): SessionAlreadyRunning =>
  new SessionAlreadyRunning({ message: "This session is already running on this runner." });

/** Builds the failure of `sendInput` for an input that was stopped before the harness took it. */
export const buildInputStopped = (): InputNotDelivered =>
  new InputNotDelivered({ message: "The session stopped before the input was delivered." });

/** Builds the failure of `sendInput` for an input that the harness refused. */
export const buildInputRefused = (harnessName: string, reason: string): InputNotDelivered =>
  new InputNotDelivered({ message: finishMessage(`${harnessName} refused the input: ${reason}`) });

/**
 * Builds the failure of `sendInput` for a harness that could not be reached
 * while the input was handed over. It is not known whether the input arrived.
 */
export const buildInputLost = (harnessName: string, reason: string): HarnessProtocolError =>
  new HarnessProtocolError({
    message: finishMessage(
      `The runner lost contact with ${harnessName} while sending it the input, so the input may or may not have arrived: ${reason}`,
    ),
  });

/**
 * Builds the failure of `sendInput` for a harness that refused to change the
 * model. `change` is the change that was asked for, as a verb phrase such as
 * "switch to the model x".
 */
export const buildModelChangeRefused = (
  harnessName: string,
  change: string,
  reason: string,
): ModelChangeRefused =>
  new ModelChangeRefused({
    message: finishMessage(
      `${harnessName} refused to ${change}, so the session keeps its current model and the input was not sent: ${reason}`,
    ),
  });

/**
 * Builds the failure of `sendInput` for a harness that did not answer a
 * request to change the model. It is not known whether the model changed, and
 * the input was not sent.
 */
export const buildModelChangeLost = (harnessName: string, reason: string): HarnessProtocolError =>
  new HarnessProtocolError({
    message: finishMessage(
      `The runner lost contact with ${harnessName} while changing the model, so the model may or may not have changed and the input was not sent: ${reason}`,
    ),
  });
