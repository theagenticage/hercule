/**
 * PROTOTYPE, throwaway. Starting work from the Inbox, in a large centered
 * dialog with two tabs:
 *
 * - **Thread**: talk to an agent. It looks like a thread: the Task's title,
 *   the things it starts from as cards, the opening message (pre-written or
 *   the user's own), and the composer with defaults that say why. "What the
 *   agent gets" shows the exact digest it starts with (context.ts). After
 *   "Start thread" the dialog turns into the transcript's first moments: the
 *   message with its things as live cards, the context it carried, and the
 *   agent reading them.
 * - **Workflow**: today's hand-off, unchanged in substance: the workflows
 *   whose input fits these things (spec 20 §8.8), the ones that cannot with
 *   their reason, and the account they act as.
 *
 * "Make a Task only" makes a to-do with no thread. Every Thread belongs to a
 * Task, so starting a thread makes the Task too.
 */
import { useEffect, useRef, useState, type JSX } from "react";
import { buildSessionLook, Face } from "../../faces";
import { ThingCard } from "./cards";
import { buildContext, type Origin } from "./context";
import { openDraft, useInbox } from "./inbox-store";
import { Mark } from "./parts";
import { createTask, startWorkflow } from "./start";
import "./thread-dialog.css";
import { offerForThings, WORKFLOWS } from "./work";
import type { Thing, World } from "./world";

type Starter = "investigate" | "fix" | "reply" | "summarise" | "blank";

interface Pick {
  readonly value: string;
  readonly why: string;
}

/** Works out the project, workspace, profile and access a thread on these things should start with, and why. */
function decideDefaults(
  things: readonly Thing[],
  world: World,
): { project: Pick; workspace: Pick; profile: Pick; access: Pick } {
  const pr = things.find((t) => t.kind.id === "github/pull-request");
  const issue = things.find((t) => t.kind.id === "linear/issue");
  const error = things.find((t) => t.kind.id === "sentry/issue");
  let project: Pick;
  if (pr)
    project = {
      value: pr.place.name.split("/")[1]!,
      why: `from ${pr.place.name}, the repository of ${pr.identifier}`,
    };
  else if (error)
    project = { value: "monorepo", why: `${error.place.name} is deployed from northwind/monorepo` };
  else if (issue) {
    const p = world.projects.find((x) => x.id === issue.projectId);
    project = {
      value: issue.place.name === "Mobile" ? "mobile-app" : "monorepo",
      why: `${issue.identifier} is in ${issue.place.name}${p ? ` · ${p.name}` : ""}, which builds in that repository`,
    };
  } else
    project = {
      value: "No project",
      why: "nothing here points at code, so the agent works without a checkout",
    };
  const code = project.value !== "No project";
  return {
    project,
    workspace: code
      ? {
          value: "New workspace from main",
          why: "the work may change code, so it gets its own branch",
        }
      : { value: "No checkout", why: "nothing to check out" },
    profile: {
      value: "Opus 5.5 · high",
      why: code ? `${project.value}'s default profile` : "your default profile",
    },
    access: code
      ? {
          value: "Edits accepted",
          why: "it may edit files in its own workspace; anything else asks",
        }
      : { value: "Ask first", why: "it may draft replies, never send them" },
  };
}

/** Writes the opening message for a starter. It names the work, not the things: they travel as references beside it. */
function writeMessage(starter: Starter, things: readonly Thing[]): string {
  const n = things.length;
  const these = n === 1 ? "this" : `these ${String(n)}`;
  const asker = things.find((t) => t.asksYou && t.turn === "you");
  switch (starter) {
    case "investigate":
      return `Look into ${these} and tell me what is going on before changing anything. Say what you think the cause is, how sure you are, and what you would do next.`;
    case "fix":
      return `Fix ${these} and open a pull request. Keep the change as small as it can be, add a test for the case, and stop to ask me if it needs a migration.`;
    case "reply":
      return `Draft a reply${asker ? ` to ${asker.face.sender ?? asker.face.company ?? asker.person}` : ""}. Do not send it: show me the draft, and say what you checked to write it.`;
    case "summarise":
      return `Summarise where ${these} stand${n === 1 ? "s" : ""}: who is waiting on whom, what changed this week, and what is still open.`;
    case "blank":
      return "";
  }
}

export function ThreadDialog({ world }: { readonly world: World }): JSX.Element | null {
  const { draft } = useInbox();
  if (draft === null) return null;
  return (
    <Dialog
      key={draft.ids.join(",")}
      world={world}
      ids={draft.ids}
      firstTitle={draft.title}
      origin={draft.origin ?? { type: "selection" }}
    />
  );
}

function Dialog({
  world,
  ids,
  firstTitle,
  origin,
}: {
  readonly world: World;
  readonly ids: readonly string[];
  readonly firstTitle: string;
  readonly origin: Origin;
}): JSX.Element {
  const [tab, setTab] = useState<"thread" | "workflow">("thread");
  const [attached, setAttached] = useState<readonly string[]>(ids);
  const things = attached
    .map((id) => world.byId.get(id))
    .filter((t): t is Thing => t !== undefined);
  const talky = things.every((t) => t.kind.stageWeight === "turn");
  const [starter, setStarter] = useState<Starter>(talky ? "reply" : "investigate");
  const [message, setMessage] = useState(() =>
    writeMessage(talky ? "reply" : "investigate", things),
  );
  const [title, setTitle] = useState(firstTitle);
  const [open, setOpen] = useState<string | null>(null);
  const [showContext, setShowContext] = useState(false);
  const [started, setStarted] = useState<string | null>(null);
  const defaults = decideDefaults(things, world);
  const context = buildContext(things, world, origin);
  const textRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => textRef.current?.focus(), []);

  const start = (withThread: boolean): void => {
    createTask({
      title,
      things,
      lane: defaults.project.value === "No project" ? "hercule" : defaults.project.value,
      withThread,
    });
    if (withThread) setStarted(message);
    else openDraft(null);
  };

  return (
    <div className="td-scrim" onMouseDown={() => openDraft(null)}>
      <div
        className="td"
        role="dialog"
        aria-label="Start work"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") openDraft(null);
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && tab === "thread" && started === null)
            start(true);
        }}
      >
        <header className="td-head">
          <span className="td-face">
            <Face
              look={buildSessionLook("new-thread", "thread")}
              pose={started === null ? "idle" : "working"}
              size={28}
            />
          </span>
          <div className="td-head-text">
            <input
              className="td-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              aria-label="Task title"
              readOnly={started !== null}
            />
            <span className="td-sub">
              {started === null
                ? `A new Task · ${defaults.project.value}`
                : `Thread started · ${defaults.project.value} · ${defaults.profile.value}`}
            </span>
          </div>
          {started === null ? (
            <span className="td-tabs" role="group" aria-label="Start as">
              <button
                type="button"
                aria-pressed={tab === "thread"}
                onClick={() => setTab("thread")}
              >
                Thread
              </button>
              <button
                type="button"
                aria-pressed={tab === "workflow"}
                onClick={() => setTab("workflow")}
              >
                Workflow
              </button>
            </span>
          ) : null}
          <button
            type="button"
            className="td-close"
            onClick={() => openDraft(null)}
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        {started !== null ? (
          <Transcript things={things} message={started} context={context} />
        ) : tab === "workflow" ? (
          <WorkflowTab things={things} />
        ) : (
          <>
            <div className="td-transcript">
              <div className="td-context">
                <p className="td-context-head">
                  Starts from {things.length} {things.length === 1 ? "thing" : "things"}
                  {origin.type === "bundle"
                    ? `, your bundle "${origin.name}"`
                    : origin.type === "proposal"
                      ? ", a Proposal you accepted"
                      : ""}
                  . They travel as references; the agent reads what it needs.
                </p>
                <ul>
                  {things.map((t) => (
                    <li key={t.id}>
                      <Mark source={t.source} size={13} />
                      <span className="td-id">{t.identifier}</span>
                      <span className="td-thing">{t.title}</span>
                      <span className="td-muted">{t.kind.noun}</span>
                      <button
                        type="button"
                        onClick={() => setAttached(attached.filter((x) => x !== t.id))}
                        aria-label="Leave out"
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="td-peek"
                  aria-expanded={showContext}
                  onClick={() => setShowContext(!showContext)}
                >
                  {showContext ? "▾" : "▸"} What the agent gets · about {context.tokens} tokens
                </button>
                {showContext ? <pre className="td-digest">{context.text}</pre> : null}
              </div>
            </div>

            <div className="td-starters" role="group" aria-label="Start from">
              <span className="td-muted">Start from</span>
              {(
                [
                  ["investigate", "Investigate"],
                  ["fix", "Fix"],
                  ["reply", "Draft a reply"],
                  ["summarise", "Summarise"],
                  ["blank", "My own words"],
                ] as const
              ).map(([s, label]) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={starter === s}
                  onClick={() => {
                    setStarter(s);
                    setMessage(writeMessage(s, things));
                    textRef.current?.focus();
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="td-composer">
              <div className="td-attached">
                {things.map((t) => (
                  <span key={t.id} className="td-chip" title={t.title}>
                    <Mark source={t.source} size={11} /> {t.identifier || t.title.slice(0, 24)}
                  </span>
                ))}
              </div>
              <textarea
                ref={textRef}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="What should the agent do?"
                rows={5}
              />
              <div className="td-picks">
                {(
                  [
                    ["project", "Project", defaults.project],
                    ["workspace", "Workspace", defaults.workspace],
                    ["profile", "Profile", defaults.profile],
                    ["access", "Access", defaults.access],
                  ] as const
                ).map(([key, label, pick]) => (
                  <span key={key} className="td-pick-wrap">
                    <button
                      type="button"
                      className="td-pick"
                      aria-expanded={open === key}
                      onClick={() => setOpen(open === key ? null : key)}
                    >
                      <span className="td-muted">{label}</span> {pick.value} ▾
                    </button>
                    {open === key ? (
                      <span className="td-why">
                        <b>{pick.value}</b>
                        <span>Chosen because {pick.why}.</span>
                      </span>
                    ) : null}
                  </span>
                ))}
              </div>
            </div>

            <footer className="td-foot">
              <button
                type="button"
                className="td-secondary"
                onClick={() => start(false)}
                title="A to-do: the Task, with nobody on it yet"
              >
                Make a Task only
              </button>
              <span className="td-muted">The Task can be started later from Work.</span>
              <span className="td-push" />
              <button
                type="button"
                className="td-primary"
                disabled={message.trim() === "" || things.length === 0}
                onClick={() => start(true)}
              >
                Start thread <kbd>⌘↩</kbd>
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

/** The Workflow tab: the hand-off as it is today, offered by what each workflow's input takes. */
function WorkflowTab({ things }: { readonly things: readonly Thing[] }): JSX.Element {
  const offers = WORKFLOWS.filter(
    (w) => w.input.type === "thing" || w.input.type === "things" || w.input.type === "each",
  ).map((w) => ({ w, ...offerForThings(w, things) }));
  const fits = offers.filter((o) => o.ok);
  const not = offers.filter((o) => !o.ok);
  return (
    <div className="td-workflows">
      <p className="td-muted">
        Hand these to a workflow: it runs on its own, makes or joins the Task, and answers the
        signals it is made for.
      </p>
      {fits.map((o) => (
        <div key={o.w.id} className="td-wf">
          <span className="td-face">
            <Face look={buildSessionLook(o.w.agent, "run")} pose="idle" size={26} />
          </span>
          <div className="td-wf-text">
            <b>{o.w.name}</b>
            <span className="td-muted">{o.w.does}</span>
          </div>
          <span className="td-muted">
            {o.runs === 1 ? "1 run" : `${String(o.runs)} runs`}
            {o.why ? ` · ${o.why}` : ""}
          </span>
          <button
            type="button"
            className="td-primary"
            onClick={() => {
              startWorkflow(o.w, { type: "things", things });
              openDraft(null);
            }}
          >
            Hand to it
          </button>
        </div>
      ))}
      {not.length > 0 ? <p className="td-wf-sub">Cannot take these</p> : null}
      {not.map((o) => (
        <div key={o.w.id} className="td-wf is-off">
          <span className="td-face">
            <Face look={buildSessionLook(o.w.agent, "run")} pose="idle" size={26} />
          </span>
          <div className="td-wf-text">
            <b>{o.w.name}</b>
            <span className="td-muted">{o.why}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The thread's first moments: the user's message with its things as live
 * cards (they keep updating, because they are references), the context it
 * carried, folded, and the agent reading the things through the CLI.
 */
function Transcript({
  things,
  message,
  context,
}: {
  readonly things: readonly Thing[];
  readonly message: string;
  readonly context: { readonly text: string; readonly tokens: number };
}): JSX.Element {
  const [showContext, setShowContext] = useState(false);
  const shared = context.text.split("\n").find((l) => l.startsWith("Shared: "));
  const first = [...things].sort(
    (a, b) => (b.face.users ?? 0) - (a.face.users ?? 0) || b.waitMin - a.waitMin,
  )[0];
  return (
    <div className="td-transcript td-live">
      <div className="td-msg is-user">
        <p className="td-msg-who">You</p>
        <p className="td-msg-text">{message}</p>
        <div className="td-cards">
          {things.map((t) => (
            <ThingCard key={t.id} thing={t} size="compact" />
          ))}
        </div>
        <button
          type="button"
          className="td-peek"
          aria-expanded={showContext}
          onClick={() => setShowContext(!showContext)}
        >
          {showContext ? "▾" : "▸"} Context sent with it · about {context.tokens} tokens
        </button>
        {showContext ? <pre className="td-digest">{context.text}</pre> : null}
      </div>
      <div className="td-msg is-agent">
        <p className="td-msg-who">
          <Face look={buildSessionLook("new-thread", "thread")} pose="working" size={20} /> Agent
        </p>
        {things.map((t) => (
          <p key={t.id} className="td-tool">
            <span>$</span> hercule entity read {t.id} <em>✓ {t.identifier || t.kind.noun}</em>
          </p>
        ))}
        <p className="td-msg-text">
          {shared
            ? `${shared.replace("Shared: ", "They share ").split(", ").slice(0, 2).join(" and ")}. `
            : ""}
          {first
            ? `I will start with ${first.identifier || first.title}, ${first.face.users ? `which affects the most users (${first.face.users.toLocaleString("en")})` : "which has waited longest"}, and read its ${first.kind.id === "sentry/issue" ? "stack trace" : "detail"} next.`
            : ""}
        </p>
      </div>
    </div>
  );
}
