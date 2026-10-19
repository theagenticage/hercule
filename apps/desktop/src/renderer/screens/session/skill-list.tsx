/**
 * The `$` list of skills and the `/` list of commands, docked to the top
 * edge of the composer card. Both are drawn from the skills their caller
 * passes in. The list owns no state: the editor owns the keys, the
 * highlighted row and what is picked, and this component draws them.
 *
 * The root element positions itself against the composer card, so a caller
 * renders it inside `.composer-card`, and nowhere else.
 */
import { useCallback, useEffect, useRef, type CSSProperties, type JSX } from "react";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
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

/**
 * The height of a row, in CSS pixels. Every row has this height, so a row's
 * place follows from its index and the list measures nothing. It is the value
 * of the `--s-8` token, the height of a popover menu item.
 */
const ROW_HEIGHT = 32;

/**
 * The space above the first row and below the last, in CSS pixels, which is
 * also the space kept clear around a row that scrolls into view. The
 * stylesheet's padding for the rows is the same 6px.
 */
const EDGE = 6;

/**
 * The list's greatest height, in CSS pixels: the padding above the rows and
 * seven and a half rows, so a row cut at the bottom shows that more follow.
 * The stylesheet's `max-height` is the same.
 */
const MAX_LIST_HEIGHT = EDGE + 7.5 * ROW_HEIGHT;

/** How many rows are drawn beyond each end of the visible part, so a scroll shows no gap before the next draw. */
const OVERSCAN = 4;

/** Returns the height of every row. */
const estimateRowHeight = (): number => ROW_HEIGHT;

/** Stands in for the virtualizer's observer of its element's size. Reports no size and has nothing to stop. */
const observeNothing = (): (() => void) => () => {};

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
 *   scrolls past its maximum height, and draws only the rows in and near its
 *   visible part, plus the highlighted row wherever it is, so a long list
 *   costs about what a short one costs. The options carry `aria-setsize` and
 *   `aria-posinset`, so a screen reader still counts all of them.
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

  // The highlighted row is always drawn, so `aria-activedescendant` always
  // names an element, also when the pointer scrolled the row out of view. The
  // rows are in list order, so a row drawn apart from the rest has a gap
  // before it.
  const extractRange = useCallback(
    (range: Range): number[] => {
      const indexes = defaultRangeExtractor(range);
      if (activeIndex >= skills.length || indexes.includes(activeIndex)) return indexes;
      return [...indexes, activeIndex].sort((a, b) => a - b);
    },
    [activeIndex, skills.length],
  );
  const getItemKey = useCallback((index: number) => skills[index]!.name, [skills]);

  // eslint-disable-next-line react-hooks/incompatible-library -- The virtualizer returns an object that changes inside while its identity stays the same, which the React Compiler cannot memoize, so the compiler leaves this component alone. The callbacks above keep the draws cheap instead.
  const virtualizer = useVirtualizer({
    count: skills.length,
    getScrollElement: () => rows.current,
    estimateSize: estimateRowHeight,
    getItemKey,
    rangeExtractor: extractRange,
    overscan: OVERSCAN,
    // The padding above the first row sits in the scrolling element.
    scrollMargin: EDGE,
    // The list is never taller than `MAX_LIST_HEIGHT`, and a shorter one
    // holds fewer rows than fit that height. So the virtualizer is told that
    // height from the first draw on, and observes nothing.
    initialRect: { width: 0, height: MAX_LIST_HEIGHT },
    observeElementRect: observeNothing,
  });

  useEffect(() => {
    const container = rows.current;
    if (container === null) return;
    // Scrolls as little as possible to bring the row in view with `EDGE` clear
    // around it. The first row scrolls to the top and the last to the bottom,
    // so the padding is in view with them.
    const top = EDGE + activeIndex * ROW_HEIGHT;
    if (top - EDGE < container.scrollTop) container.scrollTop = top - EDGE;
    else if (top + ROW_HEIGHT + EDGE > container.scrollTop + container.clientHeight) {
      container.scrollTop = top + ROW_HEIGHT + EDGE - container.clientHeight;
    }
  }, [activeIndex]);

  /** Returns the element that draws the option for `skill`, which is row `index`. */
  function renderRow(skill: SessionSkill, index: number): JSX.Element {
    const { checkout, skill: skillPart } = splitSkillName(skill.name);
    return (
      <div
        key={skill.name}
        id={buildSkillOptionId(id, index)}
        role="option"
        aria-selected={index === activeIndex}
        aria-setsize={skills.length}
        aria-posinset={index + 1}
        className={
          index === activeIndex ? "composer-skill-list-row is-active" : "composer-skill-list-row"
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
  }

  // The drawn rows in list order, with an empty gap before each run of rows
  // that is not drawn. A row's `start` counts the padding above the rows.
  const drawn: JSX.Element[] = [];
  let end = EDGE;
  for (const { index, start, size } of virtualizer.getVirtualItems()) {
    if (start > end)
      drawn.push(<div key={`gap:${String(index)}`} style={{ height: start - end }} />);
    drawn.push(renderRow(skills[index]!, index));
    end = start + size;
  }

  return (
    <div
      className="composer-skill-list"
      style={{ "--composer-skill-list-row": `${String(ROW_HEIGHT)}px` } as CSSProperties}
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
          <div style={{ height: virtualizer.getTotalSize() }}>{drawn}</div>
        )}
      </div>
    </div>
  );
}
