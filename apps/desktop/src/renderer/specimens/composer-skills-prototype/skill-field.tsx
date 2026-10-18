/**
 * PROTOTYPE (#766). The message field of the composer card, drawn from a
 * scene's data in place of the textarea. It is a static drawing: nothing
 * can be typed in it. A stub: the drawing replaces it.
 */
import type { JSX } from "react";
import { findSkill } from "./fixture";
import type { Scene } from "./scenes";
import { SkillChip } from "./skill-chip";
import { CommandList, SkillList } from "./skill-list";
import "./skill-field.css";

/** The placeholder the Fix thread's real field draws while it is empty, as its turn runs. */
const PLACEHOLDER = "Queued until the turn finishes…";

/**
 * Renders the field of `scene`: its runs, with chips for the skills, the
 * placeholder when it holds nothing, and above the card the list that is
 * open on it. The field uses the real `.composer-input` class, so the
 * composer's metrics apply to it as they do to the textarea.
 *
 * The list is positioned against the card, which is `position: relative`,
 * so it sits at the card's top edge at the card's full width.
 */
export function SkillField({ scene }: { readonly scene: Scene }): JSX.Element {
  const { composer, list } = scene;
  return (
    <>
      {list === undefined ? null : (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: "100%" }}>
          {list.trigger === "$" ? (
            <SkillList query={list.query} activeRow={list.activeRow} />
          ) : (
            <CommandList
              query={list.query}
              activeRow={list.activeRow}
              withOtherKinds={list.withOtherKinds ?? false}
            />
          )}
        </div>
      )}
      <div
        className="composer-input skill-field"
        role="textbox"
        aria-label="Message"
        aria-multiline="true"
        tabIndex={0}
      >
        {composer.runs.length === 0 ? (
          <span style={{ color: "var(--faint)" }}>{PLACEHOLDER}</span>
        ) : (
          composer.runs.map((run, index) =>
            run.kind === "text" ? (
              <span key={index}>{run.text}</span>
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
