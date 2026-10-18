/**
 * PROTOTYPE (#766). The message field of the composer card, drawn from a
 * scene's data in place of the textarea. It is a static drawing: nothing
 * can be typed in it. A stub: the drawing replaces it.
 */
import { useLayoutEffect, useRef, type JSX } from "react";
import { findSkill } from "./fixture";
import type { Scene } from "./scenes";
import { SkillChip } from "./skill-chip";
import { CommandList, SkillList } from "./skill-list";
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
 * while the field has the focus, and the list that is open on it. The field uses the real `.composer-input` class, so the
 * composer's metrics apply to it as they do to the textarea.
 *
 * The list is a child of the card, which is `position: relative`. The
 * list's own root positions itself against the card's top edge.
 */
export function SkillField({ scene }: { readonly scene: Scene }): JSX.Element {
  const { composer, list } = scene;
  const caret = composer.focused ? composer.caret : undefined;
  const fieldRef = useRef<HTMLDivElement>(null);
  // A textarea scrolls to its caret when it is focused, which for a field
  // that holds more than its maximum height shows the end of the text.
  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (field !== null && caret !== undefined) field.scrollTop = field.scrollHeight;
  }, [caret]);
  return (
    <>
      {list === undefined ? null : list.trigger === "$" ? (
        <SkillList query={list.query} activeRow={list.activeRow} />
      ) : (
        <CommandList
          query={list.query}
          activeRow={list.activeRow}
          withOtherKinds={list.withOtherKinds ?? false}
        />
      )}
      <div
        ref={fieldRef}
        className="composer-input skill-field"
        role="textbox"
        aria-label="Message"
        aria-multiline="true"
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
