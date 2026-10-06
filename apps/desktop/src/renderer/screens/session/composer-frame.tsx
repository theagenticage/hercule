import { useRef, type FocusEvent, type JSX, type ReactNode, type Ref } from "react";
import { MicIcon } from "../../icons/mic";
import { PlusIcon } from "../../icons/plus";
import { SendIcon } from "../../icons/send";
import { StopIcon } from "../../icons/stop";
import { isSendKey } from "./send-key";
import "./composer.css";

/**
 * The class of the Request pager line, which a thread's agent page draws
 * above the dock (`AgentRequestDock`). The frame reads it too: a click or
 * focus on the line keeps the composer at its size, as `dock-mini`'s answers
 * do.
 */
export const REQUEST_PAGER_CLASS = "request-pager";

/**
 * Checks that `element` is on one of the two lines the shrunk composer keeps
 * of a Request: `dock-mini` or the Request pager line.
 */
const isOnRequestLines = (element: Element): boolean =>
  element.closest(`.dock-mini, .${REQUEST_PAGER_CLASS}`) !== null;

/**
 * Checks that a click on `target` leaves the shrunk composer shrunk: it is
 * on one of `dock-mini`'s answers, or anywhere on the Request pager line. A
 * click on the rest of `dock-mini`, such as its question, expands the
 * composer like a click anywhere else.
 */
const keepsComposerShrunk = (target: EventTarget): boolean =>
  target instanceof Element &&
  target.closest(`.dock-mini button, .${REQUEST_PAGER_CLASS}`) !== null;

/**
 * Renders a composer's card, the Bureau book's `.composer-card`: the message
 * field, then a row with Attach, `start`, `note` in the space between, `end`,
 * Dictate, and Send, or Stop while `stop` is given. `error`, when not `null`,
 * is the line under the row. The row and the error sit in a `.fold`, which a
 * shrunk `ComposerFrame` hides.
 *
 * The card holds no state of the message. It shows `text`, and hands each
 * change to `onTextChange`. ⏎ in the field calls `onSend`, and ⇧⏎ starts a
 * new line. `onSend` is called whether or not `canSend` holds, so the caller
 * decides; `canSend` only draws Send as off. A `readOnly` field takes no
 * text.
 *
 * Attach and Dictate are drawn but do nothing yet, and carry
 * `aria-disabled`.
 */
export function ComposerCard({
  text,
  onTextChange,
  placeholder,
  readOnly,
  canSend,
  onSend,
  stop,
  error,
  start,
  note,
  end,
  fieldRef,
  fieldId,
  autoFocus,
  sendTitle = "Send",
}: {
  readonly text: string;
  readonly onTextChange: (text: string) => void;
  readonly placeholder: string;
  readonly readOnly: boolean;
  readonly canSend: boolean;
  readonly onSend: () => void;
  /**
   * Given while a turn runs, which draws Stop in Send's place. `stopping`
   * says a Stop is on its way, which draws Stop as off.
   */
  readonly stop?: { readonly stopping: boolean; readonly onStop: () => void } | undefined;
  readonly error: string | null;
  /** The controls after Attach. */
  readonly start?: ReactNode;
  /** The text that fills the space between `start` and `end`, so no control moves when it shows. */
  readonly note?: ReactNode;
  /** The controls before Dictate. */
  readonly end?: ReactNode;
  readonly fieldRef: Ref<HTMLTextAreaElement>;
  /** The message field's `id`, for a caller that finds the field by it. */
  readonly fieldId?: string;
  /** Whether the message field takes the focus when the card mounts. */
  readonly autoFocus?: boolean;
  /** The tooltip of Send, which names what sending does. */
  readonly sendTitle?: string;
}): JSX.Element {
  return (
    <div className="composer-card">
      <textarea
        ref={fieldRef}
        id={fieldId}
        className="composer-input"
        rows={1}
        readOnly={readOnly}
        aria-disabled={readOnly || undefined}
        aria-label="Message"
        placeholder={placeholder}
        value={text}
        autoFocus={autoFocus}
        onChange={(event) => {
          onTextChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (!isSendKey(event)) return;
          event.preventDefault();
          onSend();
        }}
      />
      <div className="fold">
        <div className="composer-row">
          <button type="button" className="icon-btn" title="Attach" aria-disabled="true">
            <PlusIcon />
          </button>
          {start}
          <span className="spacer composer-note">{note}</span>
          {end}
          <button type="button" className="icon-btn" title="Dictate" aria-disabled="true">
            <MicIcon />
          </button>
          {stop === undefined ? (
            <button
              type="button"
              className={canSend ? "send" : "send send--off"}
              title={sendTitle}
              aria-disabled={!canSend || undefined}
              onClick={onSend}
            >
              <SendIcon />
            </button>
          ) : (
            <button
              type="button"
              className="stop"
              title="Stop"
              aria-disabled={stop.stopping || undefined}
              onClick={stop.onStop}
            >
              <StopIcon size={14} />
            </button>
          )}
        </div>
        {error === null ? null : (
          <p className="composer-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Renders a composer floating over the bottom of a session's messages, as
 * the Bureau book's `.composer-wrap` draws it. The thread's composer and an
 * assistant's Conversation draw it. From top to bottom:
 *
 * - `above`, such as the tally pill, the queued inputs and the Request dock;
 * - the card, see `ComposerCard`, which takes the frame's props of the same
 *   names, and draws Stop in place of Send while `busy`;
 * - `below`, such as the thread's lip.
 *
 * The frame's own props:
 *
 * - `shrunk` draws the composer as the book's `.is-scrolled`: narrower, one
 *   line high, with only the field, the Request's pager line and its
 *   one-line `dock-mini` left. The screen decides it.
 * - `onFocusChange` is called with whether the focus is in the composer,
 *   which keeps the composer expanded. Focus on `dock-mini` or the pager line
 *   keeps the size the composer has.
 * - `scrollTranscriptToBottom` is called when a click on the shrunk composer
 *   expands it.
 * - `ref` receives the stack of `above`, the card and `below`, whose height
 *   is what the composer covers of the messages, less the 18px the stack
 *   sits above the pane's bottom edge.
 * - `error` is the line under the row, when the last send or Stop failed.
 */
export function ComposerFrame({
  text,
  onTextChange,
  placeholder,
  readOnly,
  canSend,
  onSend,
  busy,
  stopping,
  onStop,
  error,
  start,
  note,
  end,
  above,
  below,
  shrunk,
  onFocusChange,
  scrollTranscriptToBottom,
  ref,
}: {
  readonly text: string;
  readonly onTextChange: (text: string) => void;
  readonly placeholder: string;
  readonly readOnly: boolean;
  readonly canSend: boolean;
  readonly onSend: () => void;
  readonly busy: boolean;
  /** Whether a Stop is on its way, which draws Stop as off. */
  readonly stopping: boolean;
  readonly onStop: () => void;
  readonly error: string | null;
  /** The controls after Attach. */
  readonly start?: ReactNode;
  /** The text that fills the space between `start` and `end`, so no control moves when it shows. */
  readonly note?: ReactNode;
  /** The controls before Dictate. */
  readonly end?: ReactNode;
  readonly above?: ReactNode;
  readonly below?: ReactNode;
  readonly shrunk: boolean;
  readonly onFocusChange: (focused: boolean) => void;
  readonly scrollTranscriptToBottom: () => void;
  readonly ref?: Ref<HTMLDivElement> | undefined;
}): JSX.Element {
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  // Whether the pointer went down on the shrunk composer, anywhere but on
  // `dock-mini`'s answers or the pager line. By the time the click arrives,
  // the focus it moved has already expanded the composer.
  const expandOnClickRef = useRef(false);

  // Focus inside the composer keeps it expanded. Focus on the Request lines
  // keeps the size the composer has instead, so a user who answers or pages a
  // Request from the shrunk composer keeps reading the transcript.
  const reportFocus = (event: FocusEvent<HTMLDivElement>, element: EventTarget | null): void => {
    onFocusChange(
      element instanceof Element &&
        event.currentTarget.contains(element) &&
        !(shrunk && isOnRequestLines(element)),
    );
  };

  return (
    <div className="composer-wrap">
      <div
        className={shrunk ? "composer is-scrolled" : "composer"}
        ref={ref}
        onFocus={(event) => {
          reportFocus(event, event.target);
        }}
        onBlur={(event) => {
          // The focused element also loses the focus when the window does,
          // and gets it back when the window returns. The composer keeps its
          // size in between.
          if (!document.hasFocus()) return;
          reportFocus(event, event.relatedTarget);
        }}
        onPointerDown={(event) => {
          expandOnClickRef.current = shrunk && !keepsComposerShrunk(event.target);
        }}
        onClick={() => {
          if (!expandOnClickRef.current) return;
          expandOnClickRef.current = false;
          fieldRef.current?.focus();
          scrollTranscriptToBottom();
        }}
      >
        {above}
        <ComposerCard
          text={text}
          onTextChange={onTextChange}
          placeholder={placeholder}
          readOnly={readOnly}
          canSend={canSend}
          onSend={onSend}
          stop={busy ? { stopping, onStop } : undefined}
          error={error}
          start={start}
          note={note}
          end={end}
          fieldRef={fieldRef}
        />
        {below}
      </div>
    </div>
  );
}
