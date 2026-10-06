import type { JSX } from "react";

/**
 * The tooltip of every Stop that stops the whole session: the composer's,
 * an assistant's session notice's, and Stop all in the side pane. Stopping
 * the session also stops its running subagents, and queued messages are
 * delivered afterwards.
 */
export const SESSION_STOP_TITLE = "Stops the running turn and its subagents; queued messages wait";

/**
 * The button that stops an agent's work. The composer shows it while a turn
 * runs; the subagent screens show it to stop subagents. `label` names what
 * it stops, such as "Stop all" or "Stop with 2 below", and defaults to
 * "Stop". `title` is the tooltip, which says what else stopping does; a
 * button whose label says it all has none. `disabled` is set while a stop
 * is already on its way, so a second click does nothing silently.
 *
 * Its line height is set so the button is 28px tall, the height of the
 * composer's send button: a taller Stop would grow the row, and move the text
 * above it, whenever a turn starts.
 */
export function StopButton({
  label = "Stop",
  title,
  disabled = false,
  onStop,
}: {
  readonly label?: string;
  readonly title?: string | undefined;
  readonly disabled?: boolean;
  readonly onStop: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onStop}
      title={title}
      disabled={disabled}
      className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-meta leading-[18px] font-emph text-ink enabled:hover:bg-line-soft focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live disabled:cursor-not-allowed disabled:text-muted"
    >
      <span aria-hidden="true" className="size-2 rounded-[1.5px] bg-current" />
      {label}
    </button>
  );
}
