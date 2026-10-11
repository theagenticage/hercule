/**
 * The limits and the priorities a plugin's events and signal drafts must
 * respect. The public API (`@hercule/contract`) enforces them and re-exports
 * them from here, because a plugin cannot import the contract: this way a
 * plugin cuts its text to the same numbers the API checks.
 */
import { Schema } from "effect";

/**
 * The longest title a plugin's event may carry. It is one line, and a signal
 * written from the event alone takes it as its title, so it is the limit of a
 * signal's title too.
 */
export const MAX_EVENT_TITLE_LENGTH = 512;

/** The longest title of a signal. A title is a line, not a paragraph. */
export const MAX_SIGNAL_TITLE_LENGTH = 512;

/** The longest text of one message in a block, in characters. The producer sets `truncated` when it cuts. */
export const MAX_MESSAGE_TEXT_LENGTH = 16 * 1024;

/** The longest name a block shows: a person, a branch, a file path, a check. */
export const MAX_BLOCK_NAME_LENGTH = 256;

/** The longest link a block carries. */
export const MAX_BLOCK_URL_LENGTH = 2048;

/** The most messages a messages block holds. The producer records the rest in `omitted`. */
export const MAX_BLOCK_MESSAGES = 20;

/** The most failed or pending rows a checks block holds. The producer records the rest in `omitted`. */
export const MAX_CHECK_ROWS = 20;

/** The most lines of a check's log. */
export const MAX_CHECK_LOG_LINES = 40;

/** The longest log of a check, in characters, so 40 very long lines are still refused. */
export const MAX_CHECK_LOG_LENGTH = 8 * 1024;

/**
 * How much a Task matters, highest first. A signal has the same priorities,
 * so a signal and the Task made from it agree; `urgent` shows as Now. Shown
 * as bars and font weight, never as colour. The list is in ranking order, so
 * a client that shows a picker uses it as is.
 */
export const TASK_PRIORITIES = ["urgent", "high", "normal", "low"] as const;

export const TaskPriority = Schema.Literals(TASK_PRIORITIES);

export type TaskPriority = Schema.Schema.Type<typeof TaskPriority>;
