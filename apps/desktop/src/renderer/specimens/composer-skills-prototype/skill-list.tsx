/**
 * PROTOTYPE (#766). The `$` list of skills and the `/` list of commands,
 * docked to the top edge of the composer card. Both are drawn from the
 * query and the initial active row alone. The one live thing in them is the
 * highlighted row, which the arrow keys and the pointer move. Picking does
 * nothing, and Esc hides the list.
 *
 * The root element positions itself against the composer card, so a caller
 * renders it inside `.composer-card`, and nowhere else.
 */
import { useEffect, useId, useRef, useState, type JSX, type ReactNode } from "react";
import { SkillIcon } from "../../icons/skill";
import { LogoMark } from "../../logos";
import { ProviderLogo } from "../../screens/thread/provider-logo";
import { ILLUSTRATIVE_COMMANDS, rankSkills, SKILLS, type IllustrativeCommand } from "./fixture";
import { SourceBadge } from "./source-badge";
import "./skill-list.css";

/** One row of either list, with everything the row draws. */
interface ListRow {
  /** Identifies the row among the rows of its list. */
  readonly key: string;
  /** The name of the section the row sits under, or `null` for a list without sections. */
  readonly section: string | null;
  /** The start of the label that is not the name and is drawn muted: `/skill:` or `/`. */
  readonly prefix: string;
  /** The checkout part of a repository skill's label, such as `webshop:`, drawn muted. */
  readonly checkout: string;
  readonly name: string;
  readonly description: string;
  /** What the row draws before its label. The `/` list has it, the `$` list does not. */
  readonly mark: ReactNode;
  /** The skill's source, or `null` for a row that has no badge. */
  readonly source: "library" | "repository" | null;
}

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
  const needle = query.trim().toLowerCase();
  const start = needle === "" ? -1 : text.toLowerCase().indexOf(needle);
  if (start === -1) return <>{text}</>;
  const end = start + needle.length;
  return (
    <>
      {text.slice(0, start)}
      <mark>{text.slice(start, end)}</mark>
      {text.slice(end)}
    </>
  );
}

/** Returns the rows of the `$` list for `query`: every skill `rankSkills` returns, in its order. */
const buildSkillRows = (query: string): ListRow[] =>
  rankSkills(SKILLS, query).map((skill) => {
    const checkout = skill.source === "repository" ? `${skill.checkout}:` : "";
    return {
      key: `${checkout}${skill.name}`,
      section: null,
      prefix: "",
      checkout,
      name: skill.name,
      description: skill.description,
      mark: null,
      source: skill.source,
    };
  });

/** Returns the `/` list's section name and mark for a command that is not a skill. */
const describeCommandKind = (
  kind: IllustrativeCommand["kind"],
): { readonly section: string; readonly mark: ReactNode } =>
  kind === "hercule"
    ? { section: "Hercule", mark: <LogoMark size={16} /> }
    : { section: "Claude Code", mark: <ProviderLogo providerId="claude-code" size={16} /> };

/**
 * Returns the rows of the `/` list for `query`. A skill is labelled
 * `/skill:<name>`. With `withOtherKinds`, the Hercule and harness commands
 * whose name holds the query come first, in sections of their own: they are
 * few, and the skills are many, so placed after them the sections stay in
 * view when the list scrolls.
 */
const buildCommandRows = (query: string, withOtherKinds: boolean): ListRow[] => {
  const needle = query.trim().toLowerCase();
  const skills = buildSkillRows(query).map((row): ListRow => ({
    ...row,
    section: withOtherKinds ? "Skills" : null,
    prefix: "/skill:",
    mark: <SkillIcon size={16} />,
  }));
  const others = withOtherKinds
    ? ILLUSTRATIVE_COMMANDS.filter((each) => each.name.includes(needle)).map((each): ListRow => ({
        key: `${each.kind}/${each.name}`,
        ...describeCommandKind(each.kind),
        prefix: "/",
        checkout: "",
        name: each.name,
        description: each.description,
        source: null,
      }))
    : [];
  return [...others, ...skills];
};

/** Returns `rows` grouped into runs of the same section, each with its first row's index in `rows`. */
const groupBySection = (
  rows: ReadonlyArray<ListRow>,
): Array<{ readonly section: string | null; readonly start: number; readonly rows: ListRow[] }> => {
  const groups: Array<{ section: string | null; start: number; rows: ListRow[] }> = [];
  rows.forEach((row, index) => {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.section === row.section) last.rows.push(row);
    else groups.push({ section: row.section, start: index, rows: [row] });
  });
  return groups;
};

/** The keys the head names, as `kbd` and a label each. */
const KEY_HINTS: ReadonlyArray<{ readonly keys: ReadonlyArray<string>; readonly label: string }> = [
  { keys: ["↑↓"], label: "Move" },
  { keys: ["⏎", "⇥"], label: "Pick" },
  { keys: ["Esc"], label: "Close" },
];

/**
 * Renders a docked list: its head, its rows in sections when they have
 * them, and a line in place of the rows when there are none. Holds the
 * highlighted row: it starts at `initialActiveRow`, moves with the arrow
 * keys (wrapping at either end, as the app's popover menus do) and with the
 * pointer, and scrolls into view.
 */
function DockedList({
  title,
  query,
  rows,
  initialActiveRow,
  emptyTitle,
  emptyHint,
}: {
  readonly title: string;
  readonly query: string;
  readonly rows: ReadonlyArray<ListRow>;
  readonly initialActiveRow: number | null;
  readonly emptyTitle: string;
  readonly emptyHint: string;
}): JSX.Element | null {
  const [active, setActive] = useState(initialActiveRow);
  const [closed, setClosed] = useState(false);
  const rowsRef = useRef<HTMLDivElement>(null);
  const idPrefix = useId();
  const rowCount = rows.length;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setClosed(true);
      } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && rowCount > 0) {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((current) =>
          current === null
            ? step === 1
              ? 0
              : rowCount - 1
            : (current + step + rowCount) % rowCount,
        );
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [rowCount]);

  useEffect(() => {
    if (active === null) return;
    const container = rowsRef.current;
    if (container === null) return;
    // The first row has the first section's head above it, which "nearest" would leave out of view.
    if (active === 0) container.scrollTop = 0;
    else container.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (closed) return null;
  return (
    <div className="skill-list">
      <div className="skill-list-head">
        <b>{title}</b>
        <span className="skill-list-keys" aria-hidden="true">
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
        ref={rowsRef}
        className="skill-list-rows"
        role="listbox"
        aria-label={title}
        aria-activedescendant={active === null ? undefined : `${idPrefix}-${active}`}
      >
        {rowCount === 0 ? (
          <div className="skill-list-empty">
            <span>{emptyTitle}</span>
            <span>{emptyHint}</span>
          </div>
        ) : (
          groupBySection(rows).map((group) => (
            <div
              key={group.section ?? ""}
              role={group.section === null ? "presentation" : "group"}
              aria-label={group.section ?? undefined}
              className="skill-list-group"
            >
              {group.section === null ? null : (
                <div className="skill-list-section" aria-hidden="true">
                  {group.section}
                </div>
              )}
              {group.rows.map((row, offset) => {
                const index = group.start + offset;
                return (
                  <div
                    key={row.key}
                    id={`${idPrefix}-${index}`}
                    role="option"
                    aria-selected={index === active}
                    data-index={index}
                    className={index === active ? "skill-list-row is-active" : "skill-list-row"}
                    // Pointer movement, not entry: scrolling a row under a still pointer must not steal the highlight.
                    onPointerMove={() => {
                      setActive(index);
                    }}
                  >
                    {row.mark === null ? null : <span className="skill-list-mark">{row.mark}</span>}
                    <span className="skill-list-name">
                      {row.prefix === "" && row.checkout === "" ? null : (
                        <span className="skill-list-dim">{`${row.prefix}${row.checkout}`}</span>
                      )}
                      {row.name}
                    </span>
                    <span className="skill-list-description">
                      <MarkedText text={row.description} query={query} />
                    </span>
                    {row.source === null ? null : <SourceBadge source={row.source} />}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Renders the skills `rankSkills` returns for `query`, one row each, with
 * row `activeRow` highlighted at first, or the empty state when none matches.
 * Returns `null` once Esc has hidden the list.
 */
export function SkillList({
  query,
  activeRow,
}: {
  readonly query: string;
  readonly activeRow: number | null;
}): JSX.Element | null {
  return (
    <DockedList
      title="Skills"
      query={query}
      rows={buildSkillRows(query)}
      initialActiveRow={activeRow}
      emptyTitle={`No skill matches “${query}”`}
      emptyHint="Skills come from the Skill Library and the checkout's own skills."
    />
  );
}

/**
 * Renders the commands that match `query`, one row each, with row
 * `activeRow` highlighted at first. Skills show as `/skill:<name>`. With
 * `withOtherKinds`, the illustrative Hercule and harness commands are
 * listed beside them, in sections. Returns `null` once Esc has hidden the list.
 */
export function CommandList({
  query,
  activeRow,
  withOtherKinds,
}: {
  readonly query: string;
  readonly activeRow: number | null;
  readonly withOtherKinds: boolean;
}): JSX.Element | null {
  return (
    <DockedList
      title="Commands"
      query={query}
      rows={buildCommandRows(query, withOtherKinds)}
      initialActiveRow={activeRow}
      emptyTitle={`No command matches “${query}”`}
      emptyHint="Commands come from Hercule, the harness and the thread's skills."
    />
  );
}
