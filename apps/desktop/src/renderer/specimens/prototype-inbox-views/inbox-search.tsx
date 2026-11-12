/**
 * PROTOTYPE, throwaway. The Inbox's search bar, moved out of view-inbox.tsx
 * unchanged in round five.
 */
import {
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import {
  countValues,
  describeClause,
  EMPTY_QUERY,
  FIELDS,
  findField,
  listFields,
  parseAge,
  runQuery,
  type Clause,
  type Query,
} from "./fields";
import { formatCount, type Thing, type World } from "./world";

/**
 * The search bar: chips for clauses and free text. Typing `key:` offers the
 * declared fields, then their values with counts; `>` and `<` work on numbers
 * and ages (`waiting:>2d`, `events:>1000`). Enter adds the chip, Backspace on
 * an empty field removes the last one.
 */
export function SearchBar({
  query,
  onQuery,
  things,
  world,
  inputRef,
}: {
  readonly query: Query;
  readonly onQuery: (q: Query) => void;
  readonly things: readonly Thing[];
  readonly world: World;
  readonly inputRef: RefObject<HTMLInputElement | null>;
}): JSX.Element {
  const [text, setText] = useState(query.text);
  const [pick, setPick] = useState(0);
  // A query set from outside (a split, a saved search) puts its text in the field.
  const [seenQuery, setSeenQuery] = useState(query);
  if (seenQuery !== query) {
    setSeenQuery(query);
    setText(query.text);
  }
  const token = text.split(" ").at(-1) ?? "";
  const colon = token.indexOf(":");
  const add = (c: Clause): void => {
    const rest = text.slice(0, text.length - token.length).trim();
    setText(rest);
    onQuery({ ...query, clauses: [...query.clauses, c], text: rest });
  };
  const suggestions = ((): { label: string; hint: string; apply: () => void }[] => {
    if (token === "") return [];
    const scoped = runQuery(things, { ...query, text: "" }, world);
    if (colon < 0) {
      return FIELDS.filter(
        (f) =>
          f.key.startsWith(token.toLowerCase()) ||
          f.label.toLowerCase().startsWith(token.toLowerCase()),
      )
        .slice(0, 7)
        .map((f) => ({
          label: `${f.key}:`,
          hint: `${f.label} · ${f.owner}`,
          apply: () => setText(`${text.slice(0, text.length - token.length)}${f.key}:`),
        }));
    }
    const field = findField(token.slice(0, colon));
    if (!field) return [];
    const value = token.slice(colon + 1);
    if (field.type === "number" || field.type === "age") {
      const m = value.match(/^([<>])(.+)$/);
      const n = m ? (field.type === "age" ? parseAge(m[2]!) : Number(m[2])) : undefined;
      if (!m || n === undefined || Number.isNaN(n))
        return [
          {
            label: `${field.key}:>…`,
            hint: field.type === "age" ? "for example >2d or <4h" : "for example >1000",
            apply: () => undefined,
          },
        ];
      return [
        {
          label: describeClause({ key: field.key, op: m[1] === ">" ? "gt" : "lt", value: n }),
          hint: "Enter to add",
          apply: () => add({ key: field.key, op: m[1] === ">" ? "gt" : "lt", value: n }),
        },
      ];
    }
    return countValues(field, scoped, world)
      .filter(([v]) => v.toLowerCase().includes(value.toLowerCase()))
      .slice(0, 8)
      .map(([v, n]) => ({
        label: `${field.label}: ${v}`,
        hint: formatCount(n),
        apply: () =>
          add({ key: field.key, op: "is", value: field.type === "bool" ? v === "Yes" : v }),
      }));
  })();

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "ArrowDown") setPick(Math.min(suggestions.length - 1, pick + 1));
    else if (e.key === "ArrowUp") setPick(Math.max(0, pick - 1));
    else if (e.key === "Enter") {
      if (suggestions[pick]) suggestions[pick].apply();
      else onQuery({ ...query, text });
      setPick(0);
    } else if (e.key === "Backspace" && text === "" && query.clauses.length > 0)
      onQuery({ ...query, clauses: query.clauses.slice(0, -1) });
    else if (e.key === "Escape") {
      setText("");
      onQuery(EMPTY_QUERY);
      (e.target as HTMLInputElement).blur();
    } else return;
    e.preventDefault();
  };
  return (
    <div className="ib-search">
      <span className="ib-search-icon">⌕</span>
      {query.kinds.length > 0 ? (
        <span className="ib-chip">
          {query.kinds.map((k) => world.kinds.find((x) => x.id === k)!.noun).join(" or ")}
        </span>
      ) : null}
      {query.clauses.map((c, i) => (
        <button
          key={`${c.key}-${String(i)}`}
          type="button"
          className="ib-chip"
          onClick={() => onQuery({ ...query, clauses: query.clauses.filter((_, j) => j !== i) })}
        >
          {describeClause(c)} ✕
        </button>
      ))}
      <input
        ref={inputRef}
        value={text}
        placeholder={
          query.clauses.length === 0
            ? "Search, or type a field: team:, level:, from:, waiting:>2d"
            : ""
        }
        onChange={(e) => {
          setText(e.target.value);
          setPick(0);
          if (!e.target.value.includes(":")) onQuery({ ...query, text: e.target.value });
        }}
        onKeyDown={onKeyDown}
      />
      {suggestions.length > 0 ? (
        <ol className="ib-suggest">
          {suggestions.map((s, i) => (
            <li key={s.label}>
              <button
                type="button"
                className={i === pick ? "is-on" : ""}
                onMouseDown={(e) => {
                  e.preventDefault();
                  s.apply();
                }}
              >
                <b>{s.label}</b>
                <span>{s.hint}</span>
              </button>
            </li>
          ))}
        </ol>
      ) : null}
      {listFields(query.kinds).length > 0 && query.clauses.length + query.text.length > 0 ? (
        <button
          type="button"
          className="ib-clear"
          onClick={() => {
            setText("");
            onQuery(EMPTY_QUERY);
          }}
        >
          Clear
        </button>
      ) : null}
    </div>
  );
}
