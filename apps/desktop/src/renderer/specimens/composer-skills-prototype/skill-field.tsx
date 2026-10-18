/**
 * PROTOTYPE (#766). The message field of the composer card, drawn from a
 * scene's data in place of the textarea. Nothing can be typed in it. It is
 * handed to the composer through the prototype seam, which swaps it in for
 * the real textarea.
 */
import { useCallback, useId, useLayoutEffect, useRef, useState, type JSX } from "react";
import { findSkill } from "./fixture";
import type { Scene } from "./scenes";
import { SkillChip } from "./skill-chip";
import { buildOptionId, CommandList, SkillList, type ListControl } from "./skill-list";
import "./skill-field.css";

/** The placeholder the Fix thread's real field draws while it is empty, as its turn runs. */
const PLACEHOLDER = "Queued until the turn finishes…";

/**
 * Renders `text`, with the caret drawn after its first `caretOffset`
 * characters when `caretOffset` is given. The caret is a still bar, so a
 * screenshot always shows it.
 */
function TextRun({
  text,
  caretOffset,
}: {
  readonly text: string;
  readonly caretOffset?: number | undefined;
}): JSX.Element {
  if (caretOffset === undefined) return <span>{text}</span>;
  return (
    <span>
      {text.slice(0, caretOffset)}
      <span className="skill-field-caret" />
      {text.slice(caretOffset)}
    </span>
  );
}

/**
 * Renders the field of `scene`: its runs, with chips for the skills, the
 * placeholder when it holds nothing, the caret where the scene puts it
 * while the field has the focus, and the list that is open on it. The field
 * uses the real `.composer-input` class, so the composer's metrics apply to
 * it as they do to the textarea.
 *
 * While a list is open, the field is the combobox of the pattern: it names
 * the list and the highlighted option in its ARIA attributes, and the arrow
 * keys and Esc pressed in it drive the list. The field therefore holds the
 * highlighted row and whether Esc has closed the list.
 *
 * The list is a child of the card, which is `position: relative`. The
 * list's own root positions itself against the card's top edge.
 */
export function SkillField({ scene }: { readonly scene: Scene }): JSX.Element {
  const { composer, list } = scene;
  const caret = composer.focused ? composer.caret : undefined;
  const fieldRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [active, setActive] = useState(list?.activeRow ?? null);
  const [closed, setClosed] = useState(false);
  const close = useCallback(() => {
    setClosed(true);
  }, []);
  const control: ListControl = { listId, fieldRef, active, setActive, closed, close };
  const expanded = list !== undefined && !closed;
  // A textarea scrolls to its caret when it is focused, which for a field
  // that holds more than its maximum height shows the end of the text. A
  // scene that draws the caret also gives the field the focus, so that the
  // keys work in its list as soon as the scene is shown.
  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (field === null || caret === undefined) return;
    field.focus({ preventScroll: true });
    field.scrollTop = field.scrollHeight;
  }, [caret]);
  return (
    <>
      {list === undefined ? null : list.trigger === "$" ? (
        <SkillList query={list.query} control={control} />
      ) : (
        <CommandList
          query={list.query}
          control={control}
          withOtherKinds={list.withOtherKinds ?? false}
        />
      )}
      <div
        ref={fieldRef}
        className="composer-input skill-field"
        role={list === undefined ? "textbox" : "combobox"}
        aria-label="Message"
        aria-multiline={list === undefined ? "true" : undefined}
        aria-expanded={list === undefined ? undefined : expanded}
        aria-controls={expanded ? listId : undefined}
        aria-activedescendant={
          expanded && active !== null ? buildOptionId(listId, active) : undefined
        }
        tabIndex={0}
      >
        {composer.runs.length === 0 ? (
          <span className="skill-field-placeholder">{PLACEHOLDER}</span>
        ) : (
          composer.runs.map((run, index) =>
            run.kind === "text" ? (
              <TextRun
                key={index}
                text={run.text}
                caretOffset={caret?.run === index ? caret.offset : undefined}
              />
            ) : (
              <SkillChip
                key={index}
                skill={findSkill(run.ref)}
                placement="composer"
                selected={scene.selectedChip === index}
                hovered={scene.hoveredChip === index}
              />
            ),
          )
        )}
      </div>
    </>
  );
}
