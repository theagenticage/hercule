/**
 * PROTOTYPE, throwaway. View B, Work (round four of the Horizon). Rogier,
 * 2026-11-10: what is in the inbox is also work, just not picked up yet, and
 * the same is true of Tasks made in Hercule. So this view holds both, on the
 * Horizon's time axis, with no split between "Inbox" and "Work".
 *
 * Rows are whose move it is, which is the one question both kinds of thing
 * answer:
 *
 * - Needs you: outside things that wait on you, and Tasks whose agent asks
 *   something or whose run failed.
 * - Ready to pick up: yours, nobody waiting, not started. Assigned tickets,
 *   and Tasks taken on with nobody on them.
 * - Agents on it: Tasks with a session working.
 * - Waiting on others: outside things that are someone else's turn, and
 *   Tasks that are blocked or in review.
 *
 * Columns are time through "now": how long it has been in this state on the
 * left, a real time ahead (a due date, a target, an event) on the right. A
 * Task card carries what Work shows today: stage, lane, Initiative, summary,
 * agents, the open question, a blocker, and what it links.
 */
import { useState, type JSX, type ReactNode } from "react";
import { ThingCard } from "./cards";
import { Desk, Mark } from "./parts";
import { SessionFace, StartButton, startWorkflow, toggleSelected, useWork } from "./start";
import "./view-work.css";
import { STAGES, WORKFLOWS, type Task } from "./work";
import { formatCount, formatWait, type Thing, type World } from "./world";

type RowId = "needs" | "ready" | "agents" | "others";
type Column = "before" | "today" | "later-today" | "week" | "later";
type Item =
  | { readonly type: "thing"; readonly thing: Thing }
  | { readonly type: "task"; readonly task: Task };

const SINCE_MIDNIGHT = 9 * 60 + 41;
const REST_OF_TODAY = 14 * 60 + 19;

const ROWS: readonly { readonly id: RowId; readonly label: string; readonly hint: string }[] = [
  { id: "needs", label: "Needs you", hint: "Someone waits, an agent asks, a run failed" },
  { id: "ready", label: "Ready to pick up", hint: "Yours, not started" },
  { id: "agents", label: "Agents on it", hint: "Working now" },
  { id: "others", label: "Waiting on others", hint: "Their move, blocked, in review" },
];
const PAST: readonly { readonly id: Column; readonly label: string }[] = [
  { id: "before", label: "Since before today" },
  { id: "today", label: "Since today" },
];
const FUTURE: readonly { readonly id: Column; readonly label: string }[] = [
  { id: "later-today", label: "Later today" },
  { id: "week", label: "This week" },
  { id: "later", label: "Later" },
];
const FIRST = 3;

/** Decides whose move a Task is. */
function decideTaskRow(task: Task): RowId | null {
  if (task.stage === "landed" || task.stage === "done" || task.stage === "dropped") return null;
  if (task.sessions.some((s) => s.state === "waiting" || s.state === "failed")) return "needs";
  if (task.sessions.some((s) => s.state === "working")) return "agents";
  if (task.blockedBy !== undefined || task.stage === "in-review") return "others";
  return "ready";
}

/** Decides whose move an outside thing is, or null when it is not on this page. */
function decideThingRow(t: Thing): RowId | null {
  if (t.settled || t.lapsed) return null;
  if (t.turn === "you") return t.asksYou ? "needs" : "ready";
  if (t.turn === "them") return "others";
  return null;
}

function decideColumn(sinceMin: number, ownMin: number | undefined): Column {
  if (ownMin !== undefined && ownMin >= 0)
    return ownMin <= REST_OF_TODAY ? "later-today" : ownMin <= 7 * 24 * 60 ? "week" : "later";
  if (ownMin !== undefined && ownMin < 0) return "before";
  return sinceMin > SINCE_MIDNIGHT ? "before" : "today";
}

export function ViewWork({ world }: { readonly world: World }): JSX.Element {
  const { tasks, selection } = useWork();
  const [initiative, setInitiative] = useState<string | null>(null);
  const linked = new Set(tasks.flatMap((t) => t.links));

  const cells = new Map<string, Item[]>();
  const put = (row: RowId, col: Column, item: Item): void => {
    const key = `${row}/${col}`;
    cells.set(key, [...(cells.get(key) ?? []), item]);
  };
  for (const task of tasks) {
    if (initiative !== null && task.initiative !== initiative) continue;
    const row = decideTaskRow(task);
    if (row) put(row, decideColumn(task.sinceMin, task.dueMin), { type: "task", task });
  }
  if (initiative === null) {
    for (const t of world.things) {
      if (linked.has(t.id)) continue;
      const row = decideThingRow(t);
      if (row)
        put(row, decideColumn(t.waitMin, t.face.slaMin ?? t.dueMin), { type: "thing", thing: t });
    }
  }
  // Tasks first in a cell, the most recently changed on top; then outside things, the longest waiting on top.
  for (const list of cells.values()) {
    list.sort((a, b) => {
      if (a.type !== b.type) return a.type === "task" ? -1 : 1;
      if (a.type === "task" && b.type === "task") return a.task.sinceMin - b.task.sinceMin;
      return (
        (b.type === "thing" ? b.thing.waitMin : 0) - (a.type === "thing" ? a.thing.waitMin : 0)
      );
    });
  }

  const landed = tasks.filter((t) => t.stage === "landed");
  const initiatives = [
    ...new Set(tasks.map((t) => t.initiative).filter((x): x is string => x !== undefined)),
  ];

  const tools = (
    <div className="wk-tools">
      <div className="pis-seg" role="group" aria-label="Initiative">
        <button
          type="button"
          aria-pressed={initiative === null}
          onClick={() => setInitiative(null)}
        >
          Everything
        </button>
        {initiatives.map((i) => (
          <button
            key={i}
            type="button"
            aria-pressed={initiative === i}
            onClick={() => setInitiative(i)}
          >
            {i}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <Desk tools={tools} className="wk-desk">
      <div className="wk">
        <div className="wk-grid">
          <div className="wk-corner">
            <span>
              {initiative === null
                ? "Tasks and everything not picked up yet"
                : `Tasks of ${initiative}`}
            </span>
          </div>
          {PAST.map((c) => (
            <ColumnHead
              key={c.id}
              label={c.label}
              count={ROWS.reduce((n, r) => n + (cells.get(`${r.id}/${c.id}`)?.length ?? 0), 0)}
            />
          ))}
          <div className="wk-now-head">
            <b>now</b>
          </div>
          {FUTURE.map((c) => (
            <ColumnHead
              key={c.id}
              label={c.label}
              count={ROWS.reduce((n, r) => n + (cells.get(`${r.id}/${c.id}`)?.length ?? 0), 0)}
            />
          ))}
          {ROWS.map((r) => {
            const all = [...PAST, ...FUTURE].flatMap((c) => cells.get(`${r.id}/${c.id}`) ?? []);
            const taskCount = all.filter((i) => i.type === "task").length;
            return [
              <div key={`${r.id}-h`} className={`wk-rowhead is-${r.id}`}>
                <b>{r.label}</b>
                <span>{r.hint}</span>
                <span className="wk-rowhead-n">
                  {taskCount > 0 ? `${String(taskCount)} Tasks · ` : ""}
                  {formatCount(all.length - taskCount)} not picked up
                </span>
              </div>,
              ...PAST.map((c) => (
                <Cell
                  key={`${r.id}-${c.id}`}
                  items={cells.get(`${r.id}/${c.id}`) ?? []}
                  world={world}
                  selection={selection}
                />
              )),
              <div key={`${r.id}-now`} className="wk-now" />,
              ...FUTURE.map((c) => (
                <Cell
                  key={`${r.id}-${c.id}`}
                  items={cells.get(`${r.id}/${c.id}`) ?? []}
                  world={world}
                  selection={selection}
                />
              )),
            ];
          })}
        </div>
        {landed.length > 0 ? (
          <section className="wk-landed">
            <h2>
              Landed <span>{landed.length}</span>
            </h2>
            {landed.map((t) => (
              <span key={t.id} className="wk-landed-item">
                ✓ {t.title}
              </span>
            ))}
          </section>
        ) : null}
      </div>
    </Desk>
  );
}

function ColumnHead({
  label,
  count,
}: {
  readonly label: string;
  readonly count: number;
}): JSX.Element {
  return (
    <div className="wk-colhead">
      <b>{label}</b>
      <span>{formatCount(count)}</span>
    </div>
  );
}

function Cell({
  items,
  world,
  selection,
}: {
  readonly items: readonly Item[];
  readonly world: World;
  readonly selection: readonly string[];
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const shown = open ? items : items.slice(0, FIRST);
  return (
    <div className={`wk-cell${items.length === 0 ? " is-empty" : ""}`}>
      {shown.map((item) =>
        item.type === "task" ? (
          <TaskCard key={item.task.id} task={item.task} world={world} />
        ) : (
          <Selectable
            key={item.thing.id}
            thing={item.thing}
            selected={selection.includes(item.thing.id)}
          >
            <ThingCard
              thing={item.thing}
              size="compact"
              selected={selection.includes(item.thing.id)}
            />
          </Selectable>
        ),
      )}
      {items.length > FIRST ? (
        <button type="button" className="wk-more" onClick={() => setOpen(!open)}>
          {open ? "Show fewer" : `${formatCount(items.length - FIRST)} more`}
        </button>
      ) : null}
    </div>
  );
}

/** Wraps a card so it can be selected (the tick) and started (the button), both shown on hover. */
export function Selectable({
  thing,
  selected,
  children,
}: {
  readonly thing: Thing;
  readonly selected: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className={`wk-selectable${selected ? " is-selected" : ""}`}>
      {children}
      <button
        type="button"
        className="wk-tick"
        aria-pressed={selected}
        aria-label="Select"
        onClick={() => toggleSelected(thing.id)}
      >
        {selected ? "✓" : ""}
      </button>
      <span className="wk-start">
        <StartButton thing={thing} />
      </span>
    </div>
  );
}

function TaskCard({ task, world }: { readonly task: Task; readonly world: World }): JSX.Element {
  const asking = task.sessions.find((s) => s.state === "waiting");
  const failed = task.sessions.find((s) => s.state === "failed");
  const links = task.links
    .map((id) => world.byId.get(id))
    .filter((t): t is Thing => t !== undefined);
  const stageIndex = STAGES.indexOf(task.stage);
  const cont = WORKFLOWS.find((w) => w.input.type === "task")!;
  return (
    <article className={`wk-task${asking ? " is-asking" : ""}${failed ? " is-failed" : ""}`}>
      <header className="wk-task-head">
        <span className="wk-stages" aria-label={`Stage: ${task.stage}`}>
          {STAGES.map((s, i) => (
            <i key={s} className={i < stageIndex ? "is-past" : i === stageIndex ? "is-now" : ""} />
          ))}
        </span>
        <span className="wk-stage">{task.stage}</span>
        <span className="wk-lane">
          {task.lane}
          {task.initiative ? ` · ${task.initiative}` : ""}
        </span>
        <span className="wk-push" />
        <span className="wk-faces">
          {task.sessions.map((s) => (
            <SessionFace key={s.id} session={s} size={22} />
          ))}
        </span>
      </header>
      <p className="wk-task-title">{task.title}</p>
      <p className="wk-summary">{task.summary}</p>
      {asking ? (
        <div className="wk-question">
          <span>
            <b>{asking.name}</b> asks: {asking.question}
          </span>
          <span className="wk-answers">
            <button type="button">Yes</button>
            <button type="button">No</button>
            <button type="button">Thread</button>
          </span>
        </div>
      ) : null}
      {failed ? (
        <div className="wk-failed">
          <span>
            <b>{failed.name}</b>'s run failed {formatWait(failed.sinceMin)} ago
          </span>
          <button type="button" onClick={() => startWorkflow(cont, { type: "task", task })}>
            ▶ Continue
          </button>
        </div>
      ) : null}
      {task.blockedBy ? <p className="wk-blocked">Waits on: {task.blockedBy}</p> : null}
      {links.length > 0 ? (
        <footer className="wk-links">
          {links.map((t) => (
            <span key={t.id} className="wk-link" title={`${t.title} · ${t.stage}`}>
              <Mark source={t.source} size={11} />
              {t.identifier || t.kind.noun}
              {t.flags.length > 0 ? <b> ✗</b> : null}
            </span>
          ))}
          <span className="wk-push" />
          <span className="wk-since">{formatWait(task.sinceMin)}</span>
        </footer>
      ) : (
        <footer className="wk-links">
          <span className="wk-push" />
          <span className="wk-since">
            {task.dueMin !== undefined
              ? `target in ${formatWait(task.dueMin)}`
              : formatWait(task.sinceMin)}
          </span>
        </footer>
      )}
      {!asking && !failed && task.sessions.every((s) => s.state !== "working") ? (
        <button
          type="button"
          className="wk-continue"
          onClick={() => startWorkflow(cont, { type: "task", task })}
        >
          ▶ {task.sessions.length === 0 ? "Start" : "Continue"}
        </button>
      ) : null}
    </article>
  );
}
