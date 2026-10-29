/**
 * The parts of reporting a harness message the adapter does not show that are
 * the same for every harness: the label of the `unknown` item for a message
 * nobody decided how to show, and the bounded lines that tell the runner's log
 * about it or about a message that was understood and deliberately not shown.
 * Building the item's events is not here, because it depends on each adapter's
 * own turn state.
 */
import * as Effect from "effect/Effect";
import { escapeControlCharacters } from "../report";
import { describeErrorAsFact, truncateFact } from "./text";

/**
 * Returns the label of an `unknown` item, such as `claude: system/foo_bar`:
 * the harness prefix, `: `, and the type text, truncated to fit a `Fact`. The
 * type text comes from the harness, so control characters, line and paragraph
 * separators and Unicode format characters (direction overrides) are written as
 * `\u{...}` escapes. A label with a line break or a direction override would
 * otherwise change how a client draws it. Never throws, whatever the text holds.
 */
export const buildUnknownItemLabel = (harnessPrefix: string, typeText: string): string =>
  truncateFact(`${harnessPrefix}: ${escapeControlCharacters(typeText)}`);

/**
 * The most distinct labels or keys one session's log hears of. They come from
 * text the harness sends, so a harness that sends a new type with every message
 * would otherwise fill the log and the set that remembers them.
 */
const MAX_REPORTED_UNKNOWN_LABELS = 100;

/**
 * Returns the function that writes one warning line to the runner's log,
 * annotated with the session id. It captures the services of the fiber that
 * runs this effect, loggers included, because the harness's messages are read
 * outside any fiber, and a line written there would miss `runner.log`.
 */
const captureSessionWarningWriter = (sessionId: string): Effect.Effect<(text: string) => void> =>
  Effect.map(Effect.context<never>(), (services) => (text) => {
    void Effect.runForkWith(services)(
      Effect.logWarning(text).pipe(Effect.annotateLogs({ sessionId })),
    );
  });

/**
 * Returns the function that writes a session's lines about `unknown` items to
 * the runner's log. `harnessName` is the harness as the log line names it, such
 * as `Claude`. A line names the label and never holds the message itself.
 * `error` is what failed when the message's fields could not be read.
 *
 * Each label is logged once per session, up to `MAX_REPORTED_UNKNOWN_LABELS`.
 * One more line then says that further types are not logged, and nothing is
 * logged after it.
 */
export const captureUnknownItemReporter = (
  harnessName: string,
  sessionId: string,
): Effect.Effect<(label: string, error?: unknown) => void> =>
  Effect.map(captureSessionWarningWriter(sessionId), (write) => {
    const reported = new Set<string>();
    let capReported = false;
    return (label, error) => {
      if (reported.has(label)) return;
      if (reported.size >= MAX_REPORTED_UNKNOWN_LABELS) {
        if (!capReported) {
          capReported = true;
          write(
            `${harnessName} sent more than ${MAX_REPORTED_UNKNOWN_LABELS} different unknown message types in this session. Further ones are not logged.`,
          );
        }
        return;
      }
      reported.add(label);
      write(
        error === undefined
          ? `${harnessName} sent a message type this runner has no decision for: ${label}`
          : `${harnessName} sent a message this runner could not read: ${label}. Error: ${describeErrorAsFact(error)}`,
      );
    };
  });

/**
 * Returns the function that writes a line to the runner's log about a message
 * the adapter understood but deliberately did not show, such as a frame that
 * arrived for a turn that was over. `key` names the kind of message, and `text`
 * is the line. One line is written per key per session, up to
 * `MAX_REPORTED_UNKNOWN_LABELS` keys, and nothing after that.
 */
export const captureIgnoredMessageReporter = (
  sessionId: string,
): Effect.Effect<(key: string, text: string) => void> =>
  Effect.map(captureSessionWarningWriter(sessionId), (write) => {
    const reported = new Set<string>();
    return (key, text) => {
      if (reported.has(key) || reported.size >= MAX_REPORTED_UNKNOWN_LABELS) return;
      reported.add(key);
      write(text);
    };
  });
