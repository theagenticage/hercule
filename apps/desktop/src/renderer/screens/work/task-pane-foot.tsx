import { useEffect, useRef, useState, type FormEvent, type JSX } from "react";
import type { TaskAction, TaskActionId } from "@hercule/client-core/work";
import { CheckIcon } from "../../icons/check";
import { ComposeIcon } from "../../icons/compose";
import { OverlapIcon } from "../../icons/overlap";

/**
 * Renders the line that asks what a new Thread should do, in place of the
 * foot's buttons. It starts with `words`. Return sends what is written (an
 * empty line sends nothing), and Esc takes the line back.
 */
function ThreadPrompt({
  words,
  onSend,
  onCancel,
}: {
  readonly words: string;
  readonly onSend: (prompt: string) => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const [text, setText] = useState(words);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);
  const send = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const prompt = text.trim();
    if (prompt !== "") onSend(prompt);
  };
  return (
    <form className="task-pane-thread" onSubmit={send}>
      <input
        ref={inputRef}
        value={text}
        placeholder="What should this thread do?"
        aria-label="What should this thread do?"
        onChange={(event) => {
          setText(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          // The line goes, so the focus goes back to the pane's title, not to nowhere.
          event.currentTarget
            .closest(".task-pane")
            ?.querySelector<HTMLElement>("[data-sheet-focus]")
            ?.focus();
          onCancel();
        }}
      />
      <kbd>↩</kbd>
    </form>
  );
}

/**
 * Renders the foot: Done, Start a thread and Merge on the left, and Drop alone
 * at the right. While the pane asks what a new Thread should do
 * (`threadPrompt`), the foot is that one line instead.
 */
export function Foot({
  start,
  end,
  threadPrompt,
  onAction,
}: {
  readonly start: readonly TaskAction[];
  readonly end: TaskAction;
  readonly threadPrompt: {
    readonly words: string;
    readonly onSend: (prompt: string) => void;
    readonly onCancel: () => void;
  } | null;
  readonly onAction: (id: TaskActionId) => void;
}): JSX.Element {
  const icons: Partial<Record<TaskActionId, JSX.Element>> = {
    done: <CheckIcon size={14} />,
    "start-thread": <ComposeIcon size={14} />,
    merge: <OverlapIcon size={14} />,
  };
  const draw = (action: TaskAction, className: string): JSX.Element => (
    <button
      key={action.id}
      type="button"
      className={className}
      onClick={() => {
        onAction(action.id);
      }}
    >
      {icons[action.id]}
      {action.label}
      {action.keyHint !== null && <kbd>{action.keyHint}</kbd>}
    </button>
  );
  if (threadPrompt !== null) {
    return (
      <footer className="task-pane-foot">
        <ThreadPrompt
          words={threadPrompt.words}
          onSend={threadPrompt.onSend}
          onCancel={threadPrompt.onCancel}
        />
      </footer>
    );
  }
  return (
    <footer className="task-pane-foot">
      {start.map((action) => draw(action, "task-pane-btn"))}
      {draw(end, "task-pane-btn task-pane-btn--end")}
    </footer>
  );
}
