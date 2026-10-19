/**
 * The `$` list of skills and the `/` list of commands, docked to the top
 * edge of the composer card. Both are drawn from the skills their caller
 * passes in. The list owns no state: the editor owns the keys, the
 * highlighted row and what is picked, and this component draws them.
 *
 * The root element positions itself against the composer card, so a caller
 * renders it inside `.composer-card`, and nowhere else.
 */
import { useEffect, useRef, type JSX } from "react";
import type { SessionSkill } from "@hercule/contract";
import { SkillIcon } from "../../icons/skill";
import { splitSkillName } from "./skill-chip-markup";
import { SkillSourceBadge } from "./skill-source-badge";
import "./skill-list.css";

/** Which list is drawn: the `$` list of skills, or the `/` list of commands. */
export type SkillListKind = "skills" | "commands";

/**
 * Why a list has no skills to show when the thread's skills are not known:
 * the first read is under way, or it failed with `message`.
 */
export type SkillsUnavailable =
  | { readonly status: "reading" }
  | { readonly status: "failed"; readonly message: string };

/** The keys the head names, each a `kbd` before its label. */
const KEY_HINTS: ReadonlyArray<{ readonly keys: ReadonlyArray<string>; readonly label: string }> = [
  { keys: ["↑↓"], label: "Move" },
  { keys: ["⏎", "⇥"], label: "Pick" },
  { keys: ["Esc"], label: "Close" },
];

/** The lines of a list whose skills are not known, which are the same for both lists. */
const READING = "Reading skills…";
const FAILED = "Couldn't read this thread's skills";

const LISTS = {
  skills: {
    title: "Skills",
    emptyHint: "Skills come from the Skill Library and the checkout's own skills.",
    noMatch: "No skill matches",
    none: "This thread has no skills",
  },
  commands: {
    title: "Commands",
    emptyHint: "Commands come from the thread's skills.",
    noMatch: "No command matches",
    none: "This thread has no commands",
  },
} as const;

/**
 * Returns the id of the option at row `index` of the list whose `listbox` has
 * id `listId`. The editor names the highlighted option's id in
 * `aria-activedescendant`.
 */
export const buildSkillOptionId = (listId: string, index: number): string => `${listId}-${index}`;

/**
 * Renders `text` with the first case-insensitive occurrence of `query` in a
 * `mark`, which the stylesheet draws in ink. Renders the text as it is when
 * `query` is empty or absent from it.
 */
function MarkedText({
  text,
  query,
}: {
  readonly text: string;
  readonly query: string;
}): JSX.Element {
  const needle = query.trim();
  // Searches the text itself, not a lowercased copy: lowercasing can change a string's length.
  const found =
    needle === ""
      ? null
      : new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").exec(text);
  if (found === null) return <>{text}</>;
  const start = found.index;
  const end = start + found[0].length;
  return (
    <>
      {text.slice(0, start)}
      <mark>{text.slice(start, end)}</mark>
      {text.slice(end)}
    </>
  );
}

/**
 * Renders the list: a head with the key hints, then one row per skill, or a
 * line in place of the rows when there are none. A row shows the skill's
 * name (`/skill:<name>` in the commands list), its description and where it
 * comes from.
 *
 * - `skills` are the rows to draw, already filtered and ranked. The list
 *   draws every row, and scrolls past its maximum height.
 * - `unavailable` is given while the thread's skills are not known. With
 *   no rows to draw, the list says they are being read, or that reading them
 *   failed and why, rather than that the thread has none.
 * - `query` is the text the user typed after `$` or `/`. The empty state
 *   names it, and a row's description marks where it matches.
 * - `activeIndex` is the highlighted row. The list scrolls it into view, and
 *   calls `onActiveIndexChange` when the pointer moves over another row.
 * - `onPick` is called with the skill whose row is clicked.
 * - `id` is the id of the `listbox`, which the editor names in
 *   `aria-controls`. Row `i` has the id `buildSkillOptionId(id, i)`.
 *
 * A press on the list never takes focus from the editor: the rows are not
 * focusable and a mouse down on the list is cancelled. Keys are the
 * editor's, which reads them and sets `aria-activedescendant`.
 */
export function SkillList({
  kind,
  skills,
  unavailable,
  query,
  activeIndex,
  onActiveIndexChange,
  onPick,
  id,
}: {
  readonly kind: SkillListKind;
  readonly skills: ReadonlyArray<SessionSkill>;
  readonly unavailable?: SkillsUnavailable | undefined;
  readonly query: string;
  readonly activeIndex: number;
  readonly onActiveIndexChange: (index: number) => void;
  readonly onPick: (skill: SessionSkill) => void;
  readonly id: string;
}): JSX.Element {
  const copy = LISTS[kind];
  const rows = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = rows.current;
    if (container === null) return;
    // The first row has the list's padding above it, which "nearest" would leave out of view.
    if (activeIndex === 0) container.scrollTop = 0;
    else container.children[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div
      className="composer-skill-list"
      // A press on a row or the head must not blur the editor.
      onMouseDown={(event) => {
        event.preventDefault();
      }}
    >
      <div className="composer-skill-list-head">
        <b>{copy.title}</b>
        <span className="composer-skill-list-keys" aria-hidden="true">
          {KEY_HINTS.map((hint) => (
            <span key={hint.label}>
              {hint.keys.map((key) => (
                <kbd key={key}>{key}</kbd>
              ))}
              {hint.label}
            </span>
          ))}
        </span>
      </div>
      <div
        ref={rows}
        className="composer-skill-list-rows"
        role="listbox"
        id={id}
        aria-label={copy.title}
      >
        {skills.length === 0 ? (
          <div className="composer-skill-list-empty">
            {unavailable === undefined ? (
              <>
                <span>{query === "" ? copy.none : `${copy.noMatch} “${query}”`}</span>
                <span>{copy.emptyHint}</span>
              </>
            ) : unavailable.status === "reading" ? (
              <span>{READING}</span>
            ) : (
              <>
                <span>{FAILED}</span>
                <span>{unavailable.message}</span>
              </>
            )}
          </div>
        ) : (
          skills.map((skill, index) => {
            const { checkout, skill: skillPart } = splitSkillName(skill.name);
            return (
              <div
                key={skill.name}
                id={buildSkillOptionId(id, index)}
                role="option"
                aria-selected={index === activeIndex}
                className={
                  index === activeIndex
                    ? "composer-skill-list-row is-active"
                    : "composer-skill-list-row"
                }
                // Pointer movement, not entry: scrolling a row under a still pointer must not steal the highlight.
                onPointerMove={() => {
                  if (index !== activeIndex) onActiveIndexChange(index);
                }}
                onClick={() => {
                  onPick(skill);
                }}
              >
                {kind === "commands" ? (
                  <span className="composer-skill-list-mark">
                    <SkillIcon size={16} />
                  </span>
                ) : null}
                <span className="composer-skill-list-name">
                  {kind === "commands" || checkout !== "" ? (
                    <span className="composer-skill-list-dim">
                      {`${kind === "commands" ? "/skill:" : ""}${checkout}`}
                    </span>
                  ) : null}
                  {skillPart}
                </span>
                <span className="composer-skill-list-description">
                  <MarkedText text={skill.description} query={query} />
                </span>
                <SkillSourceBadge source={skill.source} />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
