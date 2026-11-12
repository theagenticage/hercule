/**
 * PROTOTYPE, throwaway. Starting work, the same in every view.
 *
 * - The store holds the user's Tasks, what is selected and what has focus.
 *   Every view writes the selection and reads the Tasks, so starting work in
 *   the Inbox shows up at once on Work.
 * - `StartMenu` lists the workflows whose input fits what is selected (see
 *   work.ts): the ones that fit first, with how many runs they would make,
 *   then the ones that do not, each with its reason. "Take on" makes a Task
 *   without starting anything.
 * - `SelectionBar` appears when anything is selected; ⌘K opens the
 *   `CommandPalette` with the same offers and the workflows that take nothing.
 * - Starting makes or joins a Task with an agent on it, and a toast offers Undo.
 *
 * Nothing is sent anywhere; it all lives in memory.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX } from "react";
import { buildSessionLook, Face } from "../../faces";
import { bundleTogether, openDraft } from "./inbox-store";
import { Mark } from "./parts";
import "./start.css";
import {
  buildTasks,
  offerForThings,
  WORKFLOWS,
  type AgentSession,
  type Task,
  type Workflow,
} from "./work";
import type { Thing, World } from "./world";

interface Toast {
  readonly id: number;
  readonly text: string;
  readonly undo: readonly Task[];
}

interface WorkState {
  readonly tasks: readonly Task[];
  readonly selection: readonly string[];
  readonly toasts: readonly Toast[];
  readonly paletteOpen: boolean;
}

let state: WorkState = { tasks: [], selection: [], toasts: [], paletteOpen: false };
let world: World | null = null;
const listeners = new Set<() => void>();
const emit = (next: Partial<WorkState>): void => {
  state = { ...state, ...next };
  for (const l of listeners) l();
};

/** Starts the store over for a world: its Tasks, and nothing selected. */
export function resetWork(next: World): void {
  world = next;
  state = { tasks: buildTasks(next), selection: [], toasts: [], paletteOpen: false };
  for (const l of listeners) l();
}

export function useWork(): WorkState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

export function setSelection(ids: readonly string[]): void {
  emit({ selection: ids });
}

export function toggleSelected(id: string): void {
  emit({
    selection: state.selection.includes(id)
      ? state.selection.filter((x) => x !== id)
      : [...state.selection, id],
  });
}

export function openPalette(open: boolean): void {
  emit({ paletteOpen: open });
}

const AGENT_NAMES = [
  "Ada",
  "Grace",
  "Linus",
  "Margaret",
  "Alan",
  "Edsger",
  "Barbara",
  "Ken",
  "Frances",
  "Donald",
];
let counter = 0;

function newSession(): AgentSession {
  counter += 1;
  return {
    id: `s-new-${String(counter)}`,
    name: AGENT_NAMES[counter % AGENT_NAMES.length]!,
    state: "working",
    sinceMin: 0,
  };
}

function toast(text: string, before: readonly Task[]): void {
  const id = Date.now() + Math.random();
  emit({ toasts: [...state.toasts, { id, text, undo: before }] });
  setTimeout(() => emit({ toasts: state.toasts.filter((t) => t.id !== id) }), 6000);
}

export type Target =
  | { readonly type: "things"; readonly things: readonly Thing[] }
  | { readonly type: "task"; readonly task: Task }
  | { readonly type: "project"; readonly name: string }
  | { readonly type: "view"; readonly label: string; readonly count: number }
  | { readonly type: "none" };

/**
 * Starts a workflow on a target, as the controller would: one run, or one per
 * thing for an `each` workflow. Each run makes a Task for what it works on,
 * or joins the Task that already links it, and puts an agent on it.
 */
export function startWorkflow(workflow: Workflow, target: Target): void {
  const before = state.tasks;
  let tasks = [...state.tasks];
  const join = (things: readonly Thing[], title: string): string => {
    const existing = tasks.find((task) => things.some((t) => task.links.includes(t.id)));
    const session = newSession();
    if (existing) {
      tasks = tasks.map((task) =>
        task === existing
          ? {
              ...task,
              stage:
                task.stage === "planned" || task.stage === "exploring" ? "building" : task.stage,
              sessions: [...task.sessions, session],
              sinceMin: 0,
            }
          : task,
      );
    } else {
      tasks = [
        {
          id: `task-new-${String(++counter)}`,
          title,
          stage: "exploring",
          lane: "monorepo",
          sessions: [session],
          links: things.map((t) => t.id),
          sinceMin: 0,
          summary: `${workflow.name}: just started`,
          startedBy: workflow.name,
        },
        ...tasks,
      ];
    }
    return session.name;
  };
  if (target.type === "things") {
    const fits = target.things.filter((t) =>
      "kinds" in workflow.input ? workflow.input.kinds.includes(t.kind.id) : false,
    );
    if (workflow.input.type === "things") {
      const who = join(fits, `${workflow.name}: ${String(fits.length)} things`);
      emit({ tasks, selection: [] });
      toast(`${who} started "${workflow.name}" on ${String(fits.length)} things together`, before);
    } else {
      const names = fits.map((t) => join([t], t.title));
      emit({ tasks, selection: [] });
      toast(
        fits.length === 1
          ? `${names[0]!} started "${workflow.name}" on ${fits[0]!.identifier || fits[0]!.title}`
          : `${String(fits.length)} runs of "${workflow.name}" started, one per thing`,
        before,
      );
    }
    return;
  }
  if (target.type === "task") {
    const session = newSession();
    tasks = tasks.map((t) =>
      t.id === target.task.id
        ? {
            ...t,
            sessions: [...t.sessions.filter((s) => s.state !== "failed"), session],
            sinceMin: 0,
          }
        : t,
    );
    emit({ tasks });
    toast(`${session.name} picked up "${target.task.title}"`, before);
    return;
  }
  const label =
    target.type === "project"
      ? target.name
      : target.type === "view"
        ? `${target.label} (${String(target.count)})`
        : "";
  const session = newSession();
  tasks = [
    {
      id: `task-new-${String(++counter)}`,
      title: label ? `${workflow.name}: ${label}` : workflow.name,
      stage: "exploring",
      lane: "hercule",
      sessions: [session],
      links: [],
      sinceMin: 0,
      summary: "Just started",
      startedBy: workflow.name,
    },
    ...tasks,
  ];
  emit({ tasks });
  toast(`${session.name} started "${workflow.name}"${label ? ` on ${label}` : ""}`, before);
}

/** Makes a Task for each thing that has none, with nobody on it yet: the thing is picked up. */
/**
 * Makes one Task for some things: a to-do with nobody on it, or with a thread
 * started on it at once (an agent session with the opening message). Every
 * Thread belongs to a Task, so starting a thread always makes or joins one.
 */
export function createTask(opts: {
  readonly title: string;
  readonly things: readonly Thing[];
  readonly lane: string;
  readonly withThread: boolean;
}): void {
  const before = state.tasks;
  const session = opts.withThread ? newSession() : undefined;
  const task: Task = {
    id: `task-new-${String(++counter)}`,
    title: opts.title,
    stage: opts.withThread ? "exploring" : "planned",
    lane: opts.lane,
    sessions: session ? [session] : [],
    links: opts.things.map((t) => t.id),
    sinceMin: 0,
    summary: opts.withThread ? "Thread started, reading the context" : "To do, nobody on it yet",
  };
  emit({ tasks: [task, ...state.tasks], selection: [] });
  toast(
    session
      ? `${session.name} started a thread on "${opts.title}"`
      : `Made a Task to do: "${opts.title}"`,
    before,
  );
}

export function takeOn(things: readonly Thing[]): void {
  const before = state.tasks;
  const fresh = things.filter((t) => !state.tasks.some((task) => task.links.includes(t.id)));
  const made: Task[] = fresh.map((t) => ({
    id: `task-new-${String(++counter)}`,
    title: t.title,
    stage: "planned",
    lane: "monorepo",
    sessions: [],
    links: [t.id],
    sinceMin: 0,
    summary: "Taken on, not started",
  }));
  emit({ tasks: [...made, ...state.tasks], selection: [] });
  toast(
    made.length === 1
      ? `Took on ${fresh[0]!.identifier || fresh[0]!.title}`
      : `Took on ${String(made.length)} things as Tasks`,
    before,
  );
}

/** Draws an agent session's face, in the pose of its state. */
export function SessionFace({
  session,
  size = 20,
}: {
  readonly session: AgentSession;
  readonly size?: number;
}): JSX.Element {
  return (
    <span
      className="st-face"
      title={`${session.name}: ${session.state}${session.question ? `, asks "${session.question}"` : ""}`}
    >
      <Face
        look={buildSessionLook(session.name, "run")}
        pose={session.state === "failed" ? "idle" : session.state}
        size={size}
      />
    </span>
  );
}

function OfferRow({
  workflow,
  why,
  runs,
  ok,
  onPick,
}: {
  readonly workflow: Workflow;
  readonly why?: string | undefined;
  readonly runs: number;
  readonly ok: boolean;
  readonly onPick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`st-offer${ok ? "" : " is-off"}`}
      disabled={!ok}
      onClick={onPick}
      role="menuitem"
    >
      <span className="st-offer-name">{workflow.name}</span>
      <span className="st-offer-does">{ok ? workflow.does : why}</span>
      {ok ? (
        <span className="st-offer-runs">{runs === 1 ? "1 run" : `${String(runs)} runs`}</span>
      ) : null}
    </button>
  );
}

/** Lists what can be started on some things: fitting workflows first, then Take on, then the ones that do not fit. */
export function StartMenu({
  things,
  onDone,
}: {
  readonly things: readonly Thing[];
  readonly onDone: () => void;
}): JSX.Element {
  const offers = WORKFLOWS.filter(
    (w) => w.input.type === "thing" || w.input.type === "things" || w.input.type === "each",
  ).map((w) => ({ w, ...offerForThings(w, things) }));
  const fits = offers.filter((o) => o.ok);
  const not = offers.filter((o) => !o.ok);
  return (
    <div className="st-menu" role="menu">
      <p className="st-menu-head">
        Start work on{" "}
        {things.length === 1 ? things[0]!.identifier || "this" : `${String(things.length)} things`}
      </p>
      {fits.map((o) => (
        <OfferRow
          key={o.w.id}
          workflow={o.w}
          why={o.why}
          runs={o.runs}
          ok
          onPick={() => {
            startWorkflow(o.w, { type: "things", things });
            onDone();
          }}
        />
      ))}
      <button
        type="button"
        className="st-offer"
        role="menuitem"
        onClick={() => {
          takeOn(things);
          onDone();
        }}
      >
        <span className="st-offer-name">Take on</span>
        <span className="st-offer-does">Make a Task for it, start nothing yet</span>
      </button>
      {not.length > 0 ? <p className="st-menu-sub">Cannot take this</p> : null}
      {not.map((o) => (
        <OfferRow
          key={o.w.id}
          workflow={o.w}
          why={o.why}
          runs={0}
          ok={false}
          onPick={() => undefined}
        />
      ))}
    </div>
  );
}

/** A small "Start" button for one card, opening the StartMenu beside it. */
export function StartButton({ thing }: { readonly thing: Thing }): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <span className="st-start" ref={ref}>
      <button
        type="button"
        className="st-start-btn"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        ▶ Start
      </button>
      {open ? <StartMenu things={[thing]} onDone={() => setOpen(false)} /> : null}
    </span>
  );
}

/** The bar that appears when things are selected: how many, Start work, Take on, Clear. */
export function SelectionBar(): JSX.Element | null {
  const { selection } = useWork();
  const [open, setOpen] = useState(false);
  const things = useMemo(
    () => selection.map((id) => world?.byId.get(id)).filter((t): t is Thing => t !== undefined),
    [selection],
  );
  if (things.length === 0) return null;
  const sources = [...new Set(things.map((t) => t.source))];
  return (
    <div className="st-bar" role="toolbar" aria-label="Selection">
      <span className="st-bar-marks">
        {sources.map((s) => (
          <Mark key={s} source={s} size={13} />
        ))}
      </span>
      <b>{things.length} selected</b>
      <span className="st-bar-menu">
        <button
          type="button"
          className="st-bar-primary"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          ▶ Start work
        </button>
        {open ? <StartMenu things={things} onDone={() => setOpen(false)} /> : null}
      </span>
      <button
        type="button"
        onClick={() => openDraft({ ids: things.map((t) => t.id), title: things[0]!.title })}
      >
        Start a thread
      </button>
      {things.length > 1 ? (
        <button
          type="button"
          onClick={() => {
            bundleTogether(
              things.map((t) => t.id),
              things[0]!.title,
            );
            setSelection([]);
          }}
        >
          Bundle them
        </button>
      ) : null}
      <button type="button" onClick={() => takeOn(things)}>
        Make Tasks
      </button>
      <button type="button" onClick={() => setSelection([])}>
        Clear
      </button>
      <span className="st-bar-keys">⌘K for everything</span>
    </div>
  );
}

export function Toasts(): JSX.Element {
  const { toasts } = useWork();
  return (
    <div className="st-toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="st-toast">
          <span>{t.text}</span>
          <button
            type="button"
            onClick={() =>
              emit({ tasks: t.undo, toasts: state.toasts.filter((x) => x.id !== t.id) })
            }
          >
            Undo
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Opens on ⌘K: a search over everything that can be started now. With a
 * selection it offers what fits the selection; without one it offers the
 * workflows that take nothing, and the projects a project workflow can take.
 */
export function CommandPalette(): JSX.Element | null {
  const { paletteOpen, selection } = useWork();
  const [text, setText] = useState("");
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openPalette(!state.paletteOpen);
        setText("");
        setIndex(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  if (!paletteOpen || world === null) return null;
  const things = selection
    .map((id) => world!.byId.get(id))
    .filter((t): t is Thing => t !== undefined);
  const items: { label: string; hint: string; run: () => void }[] = [];
  if (things.length > 0) {
    for (const w of WORKFLOWS) {
      const offer = offerForThings(w, things);
      if (offer.ok)
        items.push({
          label: w.name,
          hint: `${String(offer.runs)} run${offer.runs === 1 ? "" : "s"} on ${String(things.length)} selected`,
          run: () => startWorkflow(w, { type: "things", things }),
        });
    }
    items.push({
      label: "Take on",
      hint: `${String(things.length)} selected, as Tasks`,
      run: () => takeOn(things),
    });
  }
  for (const w of WORKFLOWS.filter((x) => x.input.type === "none"))
    items.push({ label: w.name, hint: w.does, run: () => startWorkflow(w, { type: "none" }) });
  const plan = WORKFLOWS.find((w) => w.input.type === "project")!;
  for (const p of world.projects)
    items.push({
      label: `${plan.name}: ${p.name}`,
      hint: `${String(p.issues.length)} issues, everyone's`,
      run: () => startWorkflow(plan, { type: "project", name: p.name }),
    });
  const shown = items
    .filter((i) => `${i.label} ${i.hint}`.toLowerCase().includes(text.toLowerCase()))
    .slice(0, 9);
  return (
    <div className="st-scrim" onMouseDown={() => openPalette(false)}>
      <div
        className="st-palette"
        role="dialog"
        aria-label="Start work"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          value={text}
          placeholder={
            things.length > 0 ? `Start work on ${String(things.length)} selected…` : "Start work…"
          }
          onChange={(e) => {
            setText(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") openPalette(false);
            if (e.key === "ArrowDown") setIndex(Math.min(shown.length - 1, index + 1));
            if (e.key === "ArrowUp") setIndex(Math.max(0, index - 1));
            if (e.key === "Enter" && shown[index]) {
              shown[index].run();
              openPalette(false);
            }
          }}
        />
        <ol>
          {shown.map((item, i) => (
            <li key={item.label}>
              <button
                type="button"
                className={i === index ? "is-on" : ""}
                onMouseEnter={() => setIndex(i)}
                onClick={() => {
                  item.run();
                  openPalette(false);
                }}
              >
                <b>{item.label}</b>
                <span>{item.hint}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
