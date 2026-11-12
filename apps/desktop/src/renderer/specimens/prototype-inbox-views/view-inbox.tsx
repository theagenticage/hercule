/**
 * PROTOTYPE, throwaway. View A, the Inbox, round five: built to find things
 * fast and to turn what belongs together into work.
 *
 * The rail, top to bottom:
 *
 * - Splits: the user's saved searches (inbox-store.ts). A few are seeded;
 *   "Save as split" keeps any search; drag to reorder, double-click to rename.
 * - Triage: what Hercule's triage made of the inbox, suggested bundles and
 *   Proposals, decided one by one.
 * - Pinned: facet values the user starred.
 * - Browse: each source's own structure, from the facets plugins declare
 *   (facets.ts): Linear's projects and teams, Sentry's teams, Gmail's
 *   accounts and labels. A click filters, the same as the search bar would.
 *
 * The list holds Proposals and suggestions at the top of Important and
 * Triage, then the user's bundles, then what the sources link, then the rest.
 * Bundling is the user's: select and press B, or drag one row onto another.
 * A bundle starts a thread or becomes a Task in one step.
 *
 * Keys: J and K move, X selects, B bundles, T starts a thread, M makes a Task,
 * S picks a workflow, E is done, H sets aside, / searches, 1 to 9 pick a split.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type JSX,
  type PointerEvent,
  type RefObject,
} from "react";
import { EMPTY_QUERY, runQuery, type Query } from "./fields";
import { buildFacetClauses, FACETS, listAccounts, listFacetValues, type Facet } from "./facets";
import { InboxPane, type PaneTarget } from "./inbox-pane";
import { SearchBar } from "./inbox-search";
import {
  addToBundle,
  bundleTogether,
  deleteSplit,
  moveSplit,
  openDraft,
  renameSplit,
  saveSplit,
  togglePin,
  useInbox,
  type Bundle,
  type Split,
} from "./inbox-store";
import { Desk, Mark } from "./parts";
import { createTask, setSelection, toggleSelected, useWork } from "./start";
import "./view-inbox.css";
import {
  formatCount,
  formatWait,
  isPressing,
  type SourceId,
  type Thing,
  type World,
} from "./world";

type Sort = "waiting" | "newest" | "own" | "person";
const SORTS: readonly (readonly [Sort, string])[] = [
  ["waiting", "Longest waiting"],
  ["newest", "Newest"],
  ["own", "Soonest time"],
  ["person", "Person"],
];

/** Where the list's things come from: a split, a facet value, triage, the Screener, or the search bar. */
type Scope =
  | { readonly type: "split"; readonly id: string }
  | {
      readonly type: "facet";
      readonly facetId: string;
      readonly value: string;
      readonly connection?: string | undefined;
    }
  | { readonly type: "triage" }
  | { readonly type: "screener" };

type Row =
  | { readonly type: "thing"; readonly thing: Thing; readonly depth: number }
  | { readonly type: "bundle"; readonly bundle: Bundle; readonly things: readonly Thing[] }
  | {
      readonly type: "subject";
      readonly id: string;
      readonly title: string;
      readonly things: readonly Thing[];
    }
  | {
      readonly type: "suggestion";
      readonly id: string;
      readonly why: string;
      readonly things: readonly Thing[];
    }
  | {
      readonly type: "proposal";
      readonly id: string;
      readonly title: string;
      readonly things: readonly Thing[];
    };

const keyOf = (r: Row): string =>
  r.type === "thing"
    ? `t:${r.thing.id}`
    : r.type === "bundle"
      ? `b:${r.bundle.id}`
      : `${r.type[0]!}:${r.id}`;

export function ViewInbox({ world }: { readonly world: World }): JSX.Element {
  const { tasks, selection } = useWork();
  const inbox = useInbox();
  const [scope, setScope] = useState<Scope>({ type: "split", id: "important" });
  const [query, setQuery] = useState<Query>(EMPTY_QUERY);
  const [sort, setSort] = useState<Sort>("waiting");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [screened, setScreened] = useState<ReadonlyMap<string, "allow" | "updates" | "never">>(
    new Map(),
  );
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [startOpen, setStartOpen] = useState(false);
  const [dragged, setDragged] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [paneWidth, setPaneWidth] = useState(readPaneWidth);
  const searchRef = useRef<HTMLInputElement>(null);

  const linkedIds = new Set(tasks.flatMap((t) => t.links));
  const live = world.things.filter(
    (t) => !t.settled && !t.lapsed && !gone.has(t.id) && screened.get(t.place.id) !== "never",
  );
  const searching = query.clauses.length > 0 || query.text.trim() !== "";

  const inSplit = (split: Split): Thing[] => {
    const base = split.withTask
      ? live.filter((t) => linkedIds.has(t.id))
      : live.filter((t) => !linkedIds.has(t.id));
    return runQuery(base, split.query, world);
  };
  const inFacet = (facet: Facet, value: string, connection?: string): Thing[] =>
    runQuery(
      live,
      { kinds: [], clauses: buildFacetClauses(facet, value, world, connection), text: "" },
      world,
    );

  const base = searching
    ? runQuery(live, query, world)
    : scope.type === "split"
      ? inSplit(inbox.splits.find((s) => s.id === scope.id) ?? inbox.splits[0]!)
      : scope.type === "facet"
        ? inFacet(
            FACETS.find((f) => f.id === scope.facetId)!,
            scope.value,
            scope.connection,
          )
        : [];
  const own = (t: Thing): number => t.face.slaMin ?? t.dueMin ?? Infinity;
  const found = [...base].sort(
    sort === "waiting"
      ? (a, b) => Number(isPressing(b)) - Number(isPressing(a)) || b.waitMin - a.waitMin
      : sort === "newest"
        ? (a, b) => a.waitMin - b.waitMin
        : sort === "own"
          ? (a, b) => own(a) - own(b)
          : (a, b) => a.person.localeCompare(b.person),
  );

  // Rows: triage first where it belongs, then the user's bundles, then what sources link, then the rest.
  const rows: Row[] = [];
  const placed = new Set<string>();
  const showTriage =
    !searching && (scope.type === "triage" || (scope.type === "split" && scope.id === "important"));
  if (showTriage) {
    for (const p of inbox.proposals)
      rows.push({
        type: "proposal",
        id: p.id,
        title: p.title,
        things: p.ids.map((id) => world.byId.get(id)!).filter(Boolean),
      });
    for (const s of inbox.suggestions)
      rows.push({
        type: "suggestion",
        id: s.id,
        why: s.why,
        things: s.ids.map((id) => world.byId.get(id)!).filter(Boolean),
      });
  }
  if (scope.type !== "triage") {
    const inResults = new Set(found.map((t) => t.id));
    for (const b of inbox.bundles) {
      const members = b.ids.filter((id) => inResults.has(id)).map((id) => world.byId.get(id)!);
      if (members.length === 0) continue;
      const all = b.ids.map((id) => world.byId.get(id)!).filter((t) => !gone.has(t.id));
      rows.push({ type: "bundle", bundle: b, things: all });
      for (const t of all) placed.add(t.id);
      if (open.has(`b:${b.id}`))
        for (const t of all) rows.push({ type: "thing", thing: t, depth: 1 });
    }
    for (const t of found) {
      if (placed.has(t.id)) continue;
      const mates = t.subject
        ? found.filter((o) => o.subject === t.subject && !placed.has(o.id))
        : [t];
      if (mates.length < 2) {
        rows.push({ type: "thing", thing: t, depth: 0 });
        placed.add(t.id);
        continue;
      }
      for (const m of mates) placed.add(m.id);
      const subject = world.subjects.find((s) => s.id === t.subject);
      rows.push({
        type: "subject",
        id: t.subject!,
        title: subject?.title ?? t.title,
        things: mates,
      });
      if (open.has(`s:${t.subject!}`))
        for (const m of mates) rows.push({ type: "thing", thing: m, depth: 1 });
    }
  }

  const focusIndex = Math.max(
    0,
    rows.findIndex((r) => keyOf(r) === focusKey),
  );
  const focusRow = rows[focusIndex];
  const target = ((): PaneTarget | undefined => {
    if (!focusRow) return undefined;
    switch (focusRow.type) {
      case "thing":
        return { type: "thing", thing: focusRow.thing };
      case "bundle":
        return { type: "bundle", bundle: focusRow.bundle, things: focusRow.things };
      case "subject":
        return { type: "subject", title: focusRow.title, things: focusRow.things };
      case "suggestion":
        return {
          type: "suggestion",
          suggestion: inbox.suggestions.find((s) => s.id === focusRow.id)!,
          things: focusRow.things,
        };
      case "proposal":
        return {
          type: "proposal",
          proposal: inbox.proposals.find((p) => p.id === focusRow.id)!,
          things: focusRow.things,
        };
    }
  })();
  /** The things the keys act on: the selection, else the focused row's things. */
  const acted = (): readonly Thing[] => {
    if (selection.length > 0) return selection.map((id) => world.byId.get(id)!).filter(Boolean);
    if (!focusRow) return [];
    return focusRow.type === "thing" ? [focusRow.thing] : focusRow.things;
  };
  const groupName = (r: Row): string =>
    r.type === "bundle"
      ? r.bundle.name
      : r.type === "subject" || r.type === "proposal"
        ? r.title
        : r.type === "suggestion"
          ? (r.things[0]?.title ?? "")
          : r.thing.title;
  const actedTitle = (things: readonly Thing[]): string =>
    focusRow && selection.length === 0 ? groupName(focusRow) : (things[0]?.title ?? "");

  const pick = (next: Scope): void => {
    setScope(next);
    setQuery(EMPTY_QUERY);
    setFocusKey(null);
  };
  const bundleSelection = (): void => {
    const things = acted();
    if (things.length < 2) return;
    const id = bundleTogether(
      things.map((t) => t.id),
      things[0]!.title,
    );
    setSelection([]);
    setOpen(new Set(open).add(`b:${id}`));
    setFocusKey(`b:${id}`);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement;
      if (
        el.closest("input, textarea, [role=dialog]") ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        inbox.draft
      )
        return;
      const k = e.key.toLowerCase();
      if (k === "j" || k === "arrowdown")
        setFocusKey(
          rows[Math.min(rows.length - 1, focusIndex + 1)]
            ? keyOf(rows[Math.min(rows.length - 1, focusIndex + 1)]!)
            : null,
        );
      else if (k === "k" || k === "arrowup")
        setFocusKey(
          rows[Math.max(0, focusIndex - 1)] ? keyOf(rows[Math.max(0, focusIndex - 1)]!) : null,
        );
      else if (k === "x" && focusRow?.type === "thing") toggleSelected(focusRow.thing.id);
      else if (k === "b") bundleSelection();
      else if (k === "t") {
        const things = acted();
        if (things.length > 0)
          openDraft({
            ids: things.map((t) => t.id),
            title: actedTitle(things),
            origin:
              selection.length === 0 && focusRow?.type === "bundle"
                ? { type: "bundle", name: focusRow.bundle.name }
                : { type: "selection" },
          });
      } else if (k === "m") {
        const things = acted();
        if (things.length > 0)
          createTask({ title: actedTitle(things), things, lane: "monorepo", withThread: false });
      } else if (k === "s") setStartOpen(true);
      else if (k === "e" || k === "h") {
        const things = acted();
        setGone(new Set([...gone, ...things.map((t) => t.id)]));
        setSelection([]);
      } else if (k === "/") searchRef.current?.focus();
      else if (k === "arrowright" && focusRow && focusRow.type !== "thing")
        setOpen(new Set(open).add(keyOf(focusRow)));
      else if (k === "arrowleft" && focusRow && focusRow.type !== "thing") {
        const next = new Set(open);
        next.delete(keyOf(focusRow));
        setOpen(next);
      } else if (/^[1-9]$/.test(k) && inbox.splits[Number(k) - 1])
        pick({ type: "split", id: inbox.splits[Number(k) - 1]!.id });
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const title = searching
    ? "Search"
    : scope.type === "split"
      ? (inbox.splits.find((s) => s.id === scope.id)?.name ?? "")
      : scope.type === "facet"
        ? scope.value
        : scope.type === "triage"
          ? "From triage"
          : "Screener";

  const onDropOn = (row: Row): void => {
    if (!dragged) return;
    if (row.type === "bundle") addToBundle(row.bundle.id, dragged);
    else if (row.type === "thing" && row.thing.id !== dragged) {
      const id = bundleTogether([row.thing.id, dragged], row.thing.title);
      setOpen(new Set(open).add(`b:${id}`));
    } else if (row.type === "subject" || row.type === "suggestion")
      bundleTogether(
        [...row.things.map((t) => t.id), dragged],
        row.type === "subject" ? row.title : row.things[0]!.title,
      );
    setDragged(null);
  };

  return (
    <Desk className="ib-desk" scrolls={false}>
      <div
        className="ib"
        ref={gridRef}
        style={{ "--ib-pane-w": `${String(paneWidth)}px` } as CSSProperties}
      >
        <Rail
          world={world}
          live={live}
          scope={scope}
          searching={searching}
          inSplit={inSplit}
          inFacet={inFacet}
          onPick={pick}
          onScreener={() => pick({ type: "screener" })}
        />

        <section className="ib-list" aria-label="List">
          <SearchBar
            query={query}
            onQuery={setQuery}
            things={live}
            world={world}
            inputRef={searchRef}
          />
          <div className="ib-list-tools">
            <b>{title}</b>
            <span className="ib-muted">{formatCount(found.length)}</span>
            {searching ? (
              <button
                type="button"
                className="ib-save"
                onClick={() => {
                  const name = query.text || query.clauses.map((c) => String(c.value)).join(" · ");
                  const id = saveSplit(name, query);
                  pick({ type: "split", id });
                }}
              >
                ＋ Save as split
              </button>
            ) : null}
            <span className="ib-push" />

            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as Sort)}
              aria-label="Sort"
            >
              {SORTS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div className="ib-narrow-row">
            <Narrow
              found={found}
              world={world}
              onNarrow={(clauses) =>
                setQuery({ ...query, clauses: [...query.clauses, ...clauses] })
              }
            />
          </div>
          {scope.type === "screener" && !searching ? (
            <Screener
              world={world}
              screened={screened}
              onDecide={(id, how) => setScreened(new Map(screened).set(id, how))}
            />
          ) : rows.length === 0 ? (
            <div className="ib-zero">
              <b>Nothing left in {title}.</b>
              <span>{gone.size > 0 ? `${String(gone.size)} handled this visit.` : ""}</span>
            </div>
          ) : (
            <ol className="ib-rows">
              {rows.slice(0, 260).map((row) => (
                <RowView
                  key={keyOf(row)}
                  row={row}
                  world={world}
                  focused={focusRow !== undefined && keyOf(focusRow) === keyOf(row)}
                  isOpen={open.has(keyOf(row))}
                  selected={row.type === "thing" && selection.includes(row.thing.id)}
                  hasTask={row.type === "thing" && linkedIds.has(row.thing.id)}
                  dragging={dragged !== null}
                  onFocus={() => setFocusKey(keyOf(row))}
                  onToggle={() => {
                    const next = new Set(open);
                    if (next.has(keyOf(row))) next.delete(keyOf(row));
                    else next.add(keyOf(row));
                    setOpen(next);
                  }}
                  onDragStart={(id) => setDragged(id)}
                  onDragEnd={() => setDragged(null)}
                  onDrop={() => onDropOn(row)}
                />
              ))}
            </ol>
          )}
          <p className="ib-keys">
            <kbd>J</kbd> <kbd>K</kbd> move · <kbd>X</kbd> select · <kbd>B</kbd> bundle ·{" "}
            <kbd>T</kbd> start a thread · <kbd>M</kbd> make a Task · <kbd>S</kbd> workflow ·{" "}
            <kbd>E</kbd> done · drag a row onto another to bundle them
          </p>
        </section>

        <PaneEdge gridRef={gridRef} width={paneWidth} onWidth={setPaneWidth} />
        <aside className="ib-pane" aria-label="Detail">
          <InboxPane
            target={target}
            world={world}
            tasks={tasks}
            startOpen={startOpen}
            onStartOpen={setStartOpen}
            onFocus={(id) => setFocusKey(`t:${id}`)}
          />
        </aside>
      </div>
    </Desk>
  );
}

function Rail({
  world,
  live,
  scope,
  searching,
  inSplit,
  inFacet,
  onPick,
  onScreener,
}: {
  readonly world: World;
  readonly live: readonly Thing[];
  readonly scope: Scope;
  readonly searching: boolean;
  readonly inSplit: (s: Split) => Thing[];
  readonly inFacet: (f: Facet, value: string, connection?: string) => Thing[];
  readonly onPick: (s: Scope) => void;
  readonly onScreener: () => void;
}): JSX.Element {
  const inbox = useInbox();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draggedSplit, setDraggedSplit] = useState<string | null>(null);
  const [openSources, setOpenSources] = useState<ReadonlySet<SourceId>>(new Set(["linear"]));
  const triageCount = inbox.suggestions.length + inbox.proposals.length;
  const isOn = (s: Scope): boolean => !searching && JSON.stringify(s) === JSON.stringify(scope);
  const facetSources = [...new Set(FACETS.map((f) => f.source))];
  return (
    <nav className="ib-rail" aria-label="Splits and browse">
      <p className="ib-rail-head">
        Splits <span>yours · drag to reorder</span>
      </p>
      {inbox.splits.map((s, i) => (
        <div
          key={s.id}
          className={`ib-rail-row${isOn({ type: "split", id: s.id }) ? " is-on" : ""}`}
          draggable
          onDragStart={() => setDraggedSplit(s.id)}
          onDragOver={(e: DragEvent) => e.preventDefault()}
          onDrop={() => {
            if (draggedSplit) moveSplit(draggedSplit, s.id);
            setDraggedSplit(null);
          }}
          onClick={() => onPick({ type: "split", id: s.id })}
          onDoubleClick={() => setRenaming(s.id)}
        >
          {renaming === s.id ? (
            <input
              autoFocus
              defaultValue={s.name}
              onBlur={(e) => {
                renameSplit(s.id, e.target.value || s.name);
                setRenaming(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
            />
          ) : (
            <span className="ib-rail-name">{s.name}</span>
          )}
          <span className="ib-rail-n">{formatCount(inSplit(s).length)}</span>
          {i < 9 ? <kbd>{i + 1}</kbd> : null}
          <button
            type="button"
            className="ib-rail-x"
            aria-label={`Delete ${s.name}`}
            onClick={(e) => {
              e.stopPropagation();
              deleteSplit(s.id);
            }}
          >
            ✕
          </button>
        </div>
      ))}

      <p className="ib-rail-head">Triage</p>
      <button
        type="button"
        className={`ib-rail-row${isOn({ type: "triage" }) ? " is-on" : ""}`}
        onClick={() => onPick({ type: "triage" })}
      >
        <span className="ib-rail-name">From triage</span>
        <span className="ib-rail-n is-you">{triageCount}</span>
      </button>
      <button
        type="button"
        className={`ib-rail-row${isOn({ type: "screener" }) ? " is-on" : ""}`}
        onClick={onScreener}
      >
        <span className="ib-rail-name">Screener</span>
        <span className="ib-rail-n">new places</span>
      </button>

      {inbox.pins.length > 0 ? <p className="ib-rail-head">Pinned</p> : null}
      {inbox.pins.map((p) => {
        const facet = FACETS.find((f) => f.id === p.facetId)!;
        return (
          <button
            key={p.id}
            type="button"
            className={`ib-rail-row${isOn({ type: "facet", facetId: facet.id, value: p.value, connection: p.connection }) ? " is-on" : ""}`}
            onClick={() =>
              onPick({ type: "facet", facetId: facet.id, value: p.value, connection: p.connection })
            }
          >
            <span className="ib-rail-name ib-rail-source">
              <Mark source={facet.source} size={12} /> {p.value}
              {p.connection ? (
                <span className="ib-rail-account">
                  {" "}
                  ·{" "}
                  {
                    world.sources.flatMap((x) => x.connections).find((c) => c.id === p.connection)
                      ?.label
                  }
                </span>
              ) : null}
            </span>
            <span className="ib-rail-n">
              {formatCount(inFacet(facet, p.value, p.connection).length)}
            </span>
          </button>
        );
      })}

      <p className="ib-rail-head">
        Browse <span>what each source knows</span>
      </p>
      {facetSources.map((source) => {
        const src = world.sources.find((s) => s.id === source)!;
        const isOpen = openSources.has(source);
        return (
          <div key={source} className="ib-browse">
            <button
              type="button"
              className="ib-rail-row ib-browse-source"
              aria-expanded={isOpen}
              onClick={() => {
                const next = new Set(openSources);
                if (isOpen) next.delete(source);
                else next.add(source);
                setOpenSources(next);
              }}
            >
              <span className="ib-rail-name ib-rail-source">
                <span className="ib-caret">{isOpen ? "▾" : "▸"}</span>
                <Mark source={source} size={13} /> {src.name}
              </span>
              <span className="ib-rail-n">
                {formatCount(live.filter((t) => t.source === source).length)}
              </span>
            </button>
            {isOpen ? (
              <SourceBrowse source={source} world={world} live={live} isOn={isOn} onPick={onPick} />
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}

/**
 * Browses one source. With one account it lists the source's facets; with
 * several it lists each account and its facets under it, so a value is always
 * a value of one account.
 */
function SourceBrowse({
  source,
  world,
  live,
  isOn,
  onPick,
}: {
  readonly source: SourceId;
  readonly world: World;
  readonly live: readonly Thing[];
  readonly isOn: (s: Scope) => boolean;
  readonly onPick: (s: Scope) => void;
}): JSX.Element {
  const facets = FACETS.filter((f) => f.source === source);
  const accounts = listAccounts(source, live, world);
  if (accounts.length < 2) {
    return (
      <>
        {facets.map((f) => (
          <FacetList key={f.id} facet={f} world={world} live={live} isOn={isOn} onPick={onPick} />
        ))}
      </>
    );
  }
  return (
    <>
      {accounts.map((a) => (
        <div key={a.id} className="ib-account">
          <p className="ib-account-head">
            {a.label} <span>{formatCount(a.n)}</span>
          </p>
          {facets.map((f) => (
            <FacetList
              key={f.id}
              facet={f}
              world={world}
              live={live}
              connection={a.id}
              isOn={isOn}
              onPick={onPick}
            />
          ))}
        </div>
      ))}
    </>
  );
}

function FacetList({
  facet,
  world,
  live,
  connection,
  isOn,
  onPick,
}: {
  readonly connection?: string;
  readonly facet: Facet;
  readonly world: World;
  readonly live: readonly Thing[];
  readonly isOn: (s: Scope) => boolean;
  readonly onPick: (s: Scope) => void;
}): JSX.Element {
  const inbox = useInbox();
  const [all, setAll] = useState(false);
  const values = useMemo(
    () => listFacetValues(facet, live, world, connection),
    [facet, live, world, connection],
  );
  const shown = all ? values : values.slice(0, 6);
  return (
    <div className="ib-facet">
      <p className="ib-facet-label">{facet.label}</p>
      {shown.map(({ value, n }) => {
        const note = facet.describe?.(value, world);
        const pinned = inbox.pins.some(
          (p) => p.facetId === facet.id && p.value === value && p.connection === connection,
        );
        return (
          <div
            key={value}
            className={`ib-facet-row${isOn({ type: "facet", facetId: facet.id, value, connection }) ? " is-on" : ""}${n === 0 ? " is-empty" : ""}`}
            onClick={() => onPick({ type: "facet", facetId: facet.id, value, connection })}
          >
            <span className="ib-rail-name">{value}</span>
            {note ? (
              <span className={`ib-note is-${note.tone ?? "plain"}`}>{note.note}</span>
            ) : null}
            <span className="ib-rail-n">{n === 0 ? "" : formatCount(n)}</span>
            <button
              type="button"
              className={`ib-star${pinned ? " is-on" : ""}`}
              aria-label={pinned ? "Unpin" : "Pin to the rail"}
              onClick={(e) => {
                e.stopPropagation();
                togglePin(facet.id, value, connection);
              }}
            >
              {pinned ? "★" : "☆"}
            </button>
          </div>
        );
      })}
      {values.length > 6 ? (
        <button type="button" className="ib-facet-more" onClick={() => setAll(!all)}>
          {all ? "Fewer" : `${String(values.length - 6)} more`}
        </button>
      ) : null}
    </div>
  );
}

/** The quick filters over the list: for each source in the results, its facets as menus of the values the results hold. */
function Narrow({
  found,
  world,
  onNarrow,
}: {
  readonly found: readonly Thing[];
  readonly world: World;
  readonly onNarrow: (clauses: ReturnType<typeof buildFacetClauses>) => void;
}): JSX.Element | null {
  const [open, setOpen] = useState<string | null>(null);
  const sources = new Set(found.map((t) => t.source));
  const facets = FACETS.filter((f) => sources.has(f.source)).slice(0, 8);
  if (facets.length === 0) return null;
  return (
    <span className="ib-narrow">
      <span className="ib-muted">Narrow</span>
      {facets.map((f) => (
        <span key={f.id} className="ib-narrow-wrap">
          <button
            type="button"
            className="ib-narrow-btn"
            aria-expanded={open === f.id}
            onClick={() => setOpen(open === f.id ? null : f.id)}
          >
            <Mark source={f.source} size={11} /> {f.label} ▾
          </button>
          {open === f.id ? (
            <span className="ib-narrow-menu" role="menu">
              {listFacetValues(f, found, world)
                .filter((v) => v.n > 0)
                .slice(0, 10)
                .map((v) => (
                  <button
                    key={v.value}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onNarrow(buildFacetClauses(f, v.value, world));
                      setOpen(null);
                    }}
                  >
                    <span>{v.value}</span>
                    <span className="ib-muted">{v.n}</span>
                  </button>
                ))}
            </span>
          ) : null}
        </span>
      ))}
    </span>
  );
}

function RowView({
  row,
  world,
  focused,
  isOpen,
  selected,
  hasTask,
  dragging,
  onFocus,
  onToggle,
  onDragStart,
  onDragEnd,
  onDrop,
}: {
  readonly row: Row;
  readonly world: World;
  readonly focused: boolean;
  readonly isOpen: boolean;
  readonly selected: boolean;
  readonly hasTask: boolean;
  readonly dragging: boolean;
  readonly onFocus: () => void;
  readonly onToggle: () => void;
  readonly onDragStart: (id: string) => void;
  readonly onDragEnd: () => void;
  readonly onDrop: () => void;
}): JSX.Element {
  const ref = useRef<HTMLLIElement>(null);
  const [over, setOver] = useState(false);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);
  const dropProps = {
    onDragOver: (e: DragEvent) => {
      e.preventDefault();
      setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setOver(false);
      onDrop();
    },
  };
  if (row.type !== "thing") {
    const marks = [...new Set(row.things.map((t) => t.source))];
    const asks = row.things.filter((t) => t.asksYou && t.turn === "you" && !t.settled).length;
    const label =
      row.type === "bundle"
        ? "Your bundle"
        : row.type === "subject"
          ? "Linked"
          : row.type === "suggestion"
            ? "Suggested"
            : "Proposal";
    const name =
      row.type === "bundle"
        ? row.bundle.name
        : row.type === "subject"
          ? row.title
          : row.type === "suggestion"
            ? row.why
            : row.title;
    return (
      <li
        ref={ref}
        className={`ib-group is-${row.type}${focused ? " is-focused" : ""}${over ? " is-over" : ""}`}
        onClick={onFocus}
        {...dropProps}
      >
        {row.type === "bundle" || row.type === "subject" ? (
          <button
            type="button"
            className="ib-caret"
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            aria-label={isOpen ? "Fold" : "Unfold"}
          >
            {isOpen ? "▾" : "▸"}
          </button>
        ) : (
          <span className="ib-group-icon">{row.type === "proposal" ? "◆" : "✦"}</span>
        )}
        <span className={`ib-group-label is-${row.type}`}>{label}</span>
        <span className="ib-group-marks">
          {marks.map((s) => (
            <Mark key={s} source={s} size={13} />
          ))}
        </span>
        <b className="ib-group-name">{name}</b>
        <span className="ib-muted">
          {row.things.length} things{asks > 0 ? ` · ${String(asks)} ask you` : ""}
        </span>
        <span className="ib-push" />
        <span className="ib-time">{formatWait(Math.max(...row.things.map((t) => t.waitMin)))}</span>
      </li>
    );
  }
  const t = row.thing;
  const who =
    t.face.sender ??
    t.face.company ??
    (world.sources.some((s) => s.name === t.person) ? t.place.name : t.person);
  return (
    <li
      ref={ref}
      className={`ib-row${focused ? " is-focused" : ""}${selected ? " is-selected" : ""}${row.depth > 0 ? " in-group" : ""}${t.face.unread || t.isNew ? " is-new" : ""}${over ? " is-over" : ""}${dragging ? " is-dropzone" : ""}`}
      draggable
      onDragStart={() => onDragStart(t.id)}
      onDragEnd={onDragEnd}
      onClick={onFocus}
      {...dropProps}
    >
      <button
        type="button"
        className="ib-tick"
        aria-pressed={selected}
        aria-label="Select"
        onClick={(e) => {
          e.stopPropagation();
          toggleSelected(t.id);
        }}
      >
        {selected ? "✓" : ""}
      </button>
      <Mark source={t.source} size={14} />
      <span className="ib-who">{who}</span>
      <span className="ib-line">
        <span className="ib-title">{t.title}</span>
        <span className="ib-snippet"> — {t.reason}</span>
      </span>
      {hasTask ? <span className="ib-task">Task</span> : null}
      {t.identifier ? <span className="ib-id">{t.identifier}</span> : null}
      <span className={`ib-time${isPressing(t) ? " is-long" : ""}`}>{formatWait(t.waitMin)}</span>
    </li>
  );
}

function Screener({
  world,
  screened,
  onDecide,
}: {
  readonly world: World;
  readonly screened: ReadonlyMap<string, "allow" | "updates" | "never">;
  readonly onDecide: (id: string, how: "allow" | "updates" | "never") => void;
}): JSX.Element {
  const byPlace = new Map<string, Thing[]>();
  for (const t of world.things) byPlace.set(t.place.id, [...(byPlace.get(t.place.id) ?? []), t]);
  const places = [...byPlace.entries()]
    .filter(
      ([id, things]) =>
        !screened.has(id) &&
        things.length <= 4 &&
        things.every((t) => t.isNew || t.openedMin < 2 * 24 * 60),
    )
    .slice(0, 6);
  return (
    <div className="ib-screener-list">
      <p className="ib-muted">
        New places, each decided once. What you allow keeps arriving in your splits; Updates keeps
        it out of the way; Never stops it.
      </p>
      {places.length === 0 ? <p className="ib-muted">No new places.</p> : null}
      {places.map(([id, things]) => (
        <div key={id} className="ib-screen">
          <Mark source={things[0]!.source} size={16} />
          <div>
            <b>{things[0]!.place.name}</b>
            <p className="ib-muted">
              {things.length} {things.length === 1 ? "thing" : "things"}, latest: “
              {things[0]!.title}”
            </p>
          </div>
          <span className="ib-push" />
          <button type="button" onClick={() => onDecide(id, "allow")}>
            Allow
          </button>
          <button type="button" onClick={() => onDecide(id, "updates")}>
            To Updates
          </button>
          <button type="button" onClick={() => onDecide(id, "never")}>
            Never
          </button>
        </div>
      ))}
    </div>
  );
}

const PANE_KEY = "prototype-inbox-pane-width";
const MIN_PANE = 340;
const MAX_PANE = 760;

function readPaneWidth(): number {
  const stored = Number(localStorage.getItem(PANE_KEY));
  return Number.isFinite(stored) && stored >= MIN_PANE && stored <= MAX_PANE ? stored : 440;
}

/**
 * The pane's left edge: drag it, or focus it and use the arrow keys, to make
 * the pane wider or narrower, as the subagents side pane and Intake's split
 * already do. While dragging, each move writes the width straight into the
 * grid's style with no render; the end of the drag stores it once.
 */
function PaneEdge({
  gridRef,
  width,
  onWidth,
}: {
  readonly gridRef: RefObject<HTMLDivElement | null>;
  readonly width: number;
  readonly onWidth: (w: number) => void;
}): JSX.Element {
  const clamp = (w: number): number => Math.round(Math.min(MAX_PANE, Math.max(MIN_PANE, w)));
  const store = (w: number): void => {
    localStorage.setItem(PANE_KEY, String(w));
    onWidth(w);
  };
  const live = useRef(width);
  return (
    <div
      className="ib-edge"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the detail pane"
      aria-valuenow={width}
      aria-valuemin={MIN_PANE}
      aria-valuemax={MAX_PANE}
      tabIndex={0}
      onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        live.current = width;
      }}
      onPointerMove={(e: PointerEvent<HTMLDivElement>) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId) || !gridRef.current) return;
        const right = gridRef.current.getBoundingClientRect().right;
        live.current = clamp(right - e.clientX);
        gridRef.current.style.setProperty("--ib-pane-w", `${String(live.current)}px`);
      }}
      onPointerUp={(e: PointerEvent<HTMLDivElement>) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        store(live.current);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") store(clamp(width + 24));
        else if (e.key === "ArrowRight") store(clamp(width - 24));
        else return;
        e.preventDefault();
      }}
    />
  );
}
