/**
 * The minute the Secretariat's longcase clock shows. The clock tells the real
 * local time, so it moves even while the office stands still: one frame a
 * minute. While the window is hidden it costs nothing: no timer runs, and
 * when the window shows again the hands jump to the time. The office sets
 * the clock when it builds it, so the watch only has to keep it moving.
 */

const MINUTE_MS = 60_000;

/**
 * Calls `onMinute` with the time now and then at the start of every minute
 * while the window is shown, and once more each time the window is shown
 * again. While the window is hidden it does not call `onMinute`. Returns the
 * function that stops watching.
 *
 * The timer is armed for the next minute's start each time, rather than
 * repeating every 60 seconds, so the hands never drift behind the Mac's
 * clock. Every time zone in use today is offset from UTC by whole minutes,
 * so a UTC minute starts when a local one does.
 */
export function watchMinutes(onMinute: (now: Date) => void): () => void {
  let handle: number | undefined;
  const tick = (): void => {
    const now = new Date();
    onMinute(now);
    handle = window.setTimeout(tick, MINUTE_MS - (now.getTime() % MINUTE_MS));
  };
  const onVisibilityChange = (): void => {
    window.clearTimeout(handle);
    handle = undefined;
    if (!document.hidden) tick();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  if (!document.hidden) tick();
  return () => {
    window.clearTimeout(handle);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
