/**
 * PROTOTYPE, throwaway. The Inbox's detail pane. The core owns its frame and
 * draws a plugin's blocks inside it, the way Intake's pane already draws a
 * signal's blocks (spec 17 §Intake › The pane):
 *
 * - the provenance line (source, kind, place, account), the title, who and when;
 * - the plugin's blocks (blocks.ts), each drawn by type, with a quiet line for a
 *   type the app does not know;
 * - the core's sections, which no plugin draws: your work (the Task), the
 *   bundle, what happened (the timeline), and the answers.
 *
 * The same pane shows a bundle, a suggestion of Hercule's triage, or a
 * Proposal, when one of those is selected in the list.
 */
import { useState, type JSX } from "react";
import { readAnswers, readBlocks, type Block } from "./blocks";
import { Avatar, Sparkline, ThingCard } from "./cards";
import {
  acceptSuggestion,
  dismissSuggestion,
  openDraft,
  removeFromBundle,
  renameBundle,
  settleProposal,
  ungroup,
  type Bundle,
  type Proposal,
  type Suggestion,
} from "./inbox-store";
import { Mark } from "./parts";
import { createTask, StartMenu, type useWork } from "./start";
import { findTaskOf } from "./work";
import { formatCount, formatWait, type Thing, type World } from "./world";

export type PaneTarget =
  | { readonly type: "thing"; readonly thing: Thing }
  | { readonly type: "bundle"; readonly bundle: Bundle; readonly things: readonly Thing[] }
  | { readonly type: "subject"; readonly title: string; readonly things: readonly Thing[] }
  | {
      readonly type: "suggestion";
      readonly suggestion: Suggestion;
      readonly things: readonly Thing[];
    }
  | { readonly type: "proposal"; readonly proposal: Proposal; readonly things: readonly Thing[] };

export function InboxPane({
  target,
  world,
  tasks,
  startOpen,
  onStartOpen,
  onFocus,
}: {
  readonly target: PaneTarget | undefined;
  readonly world: World;
  readonly tasks: ReturnType<typeof useWork>["tasks"];
  readonly startOpen: boolean;
  readonly onStartOpen: (open: boolean) => void;
  readonly onFocus: (id: string) => void;
}): JSX.Element {
  if (target === undefined) return <p className="ip-muted">Nothing selected.</p>;
  switch (target.type) {
    case "thing":
      return (
        <ThingPane
          thing={target.thing}
          world={world}
          tasks={tasks}
          startOpen={startOpen}
          onStartOpen={onStartOpen}
          onFocus={onFocus}
        />
      );
    case "bundle":
      return (
        <GroupPane
          key={target.bundle.id}
          kind="bundle"
          title={target.bundle.name}
          things={target.things}
          world={world}
          bundle={target.bundle}
          onFocus={onFocus}
        />
      );
    case "subject":
      return (
        <GroupPane
          key={target.title}
          kind="subject"
          title={target.title}
          things={target.things}
          world={world}
          onFocus={onFocus}
        />
      );
    case "suggestion":
      return (
        <GroupPane
          key={target.suggestion.id}
          kind="suggestion"
          title="Hercule thinks these belong together"
          why={target.suggestion.why}
          things={target.things}
          world={world}
          suggestion={target.suggestion}
          onFocus={onFocus}
        />
      );
    case "proposal":
      return (
        <GroupPane
          key={target.proposal.id}
          kind="proposal"
          title={target.proposal.title}
          why={target.proposal.why}
          things={target.things}
          world={world}
          proposal={target.proposal}
          onFocus={onFocus}
        />
      );
  }
}

function ThingPane({
  thing,
  world,
  tasks,
  startOpen,
  onStartOpen,
  onFocus,
}: {
  readonly thing: Thing;
  readonly world: World;
  readonly tasks: ReturnType<typeof useWork>["tasks"];
  readonly startOpen: boolean;
  readonly onStartOpen: (open: boolean) => void;
  readonly onFocus: (id: string) => void;
}): JSX.Element {
  const task = findTaskOf(thing, tasks);
  const source = world.sources.find((s) => s.id === thing.source)!;
  const account = source.connections.find((c) => c.id === thing.connection);
  const mates = thing.links
    .map((id) => world.byId.get(id))
    .filter((t): t is Thing => t !== undefined);
  const subject = world.subjects.find((s) => s.id === thing.subject);
  return (
    <div className="ip">
      <p className="ip-provenance">
        <Mark source={thing.source} size={13} />
        {source.name} · {thing.kind.noun} · {thing.place.name}
        {source.connections.length > 1 && account ? ` · as ${account.label}` : ""}
      </p>
      <h2 className="ip-title">
        {thing.identifier ? <span className="ip-id">{thing.identifier}</span> : null}
        {thing.title}
      </h2>
      <p className="ip-who">
        <Avatar name={thing.face.sender ?? thing.face.company ?? thing.person} size={18} />
        {thing.reason}
        <span className="ip-muted"> · {formatWait(thing.waitMin)} ago</span>
      </p>

      {readBlocks(thing, world)
        .slice(0, 8)
        .map((b, i) => (
          <BlockView key={i} block={b} />
        ))}

      {task ? (
        <section className="ip-section">
          <h3>Your work</h3>
          <p className="ip-work">
            <b>{task.title}</b>
            <span className="ip-muted">
              {" "}
              · {task.stage} ·{" "}
              {task.sessions.length > 0
                ? task.sessions.map((s) => `${s.name} ${s.state}`).join(", ")
                : "nobody on it"}
            </span>
          </p>
        </section>
      ) : null}

      {mates.length > 0 ? (
        <section className="ip-section">
          <h3>
            {subject?.title ?? "Tied to"} <span>linked by the sources · {mates.length}</span>
          </h3>
          <div className="ip-mates">
            {mates.map((m) => (
              <button key={m.id} type="button" onClick={() => onFocus(m.id)}>
                <ThingCard thing={m} size="compact" />
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section className="ip-section">
        <h3>What happened</h3>
        <ol className="ip-history">
          {[...thing.changes].reverse().map((c) => (
            <li key={`${c.label}-${String(c.atMin)}`}>
              <span>{formatWait(c.atMin)}</span>
              {c.label}
            </li>
          ))}
        </ol>
      </section>

      <footer className="ip-answers">
        {readAnswers(thing).map((a) => (
          <button key={a} type="button" className="ip-answer">
            {a}
          </button>
        ))}
        <span className="ip-push" />
        <button
          type="button"
          className="ip-answer"
          onClick={() =>
            createTask({ title: thing.title, things: [thing], lane: "monorepo", withThread: false })
          }
          title="A to-do: the Task, with nobody on it"
        >
          Make a Task <kbd>M</kbd>
        </button>
        <span className="ip-start-wrap">
          <button
            type="button"
            className="ip-answer"
            aria-expanded={startOpen}
            onClick={() => onStartOpen(!startOpen)}
          >
            Workflow ▾ <kbd>S</kbd>
          </button>
          {startOpen ? <StartMenu things={[thing]} onDone={() => onStartOpen(false)} /> : null}
        </span>
        <button
          type="button"
          className="ip-primary"
          onClick={() => openDraft({ ids: [thing.id], title: thing.title })}
        >
          Start a thread <kbd>T</kbd>
        </button>
      </footer>
    </div>
  );
}

function GroupPane({
  kind,
  title,
  why,
  things,
  world,
  bundle,
  suggestion,
  proposal,
  onFocus,
}: {
  readonly kind: "bundle" | "subject" | "suggestion" | "proposal";
  readonly title: string;
  readonly why?: string;
  readonly things: readonly Thing[];
  readonly world: World;
  readonly bundle?: Bundle;
  readonly suggestion?: Suggestion;
  readonly proposal?: Proposal;
  readonly onFocus: (id: string) => void;
}): JSX.Element {
  const [name, setName] = useState(title);
  const sources = [
    ...new Set(things.map((t) => world.sources.find((s) => s.id === t.source)!.name)),
  ];
  const asks = things.filter((t) => t.asksYou && t.turn === "you" && !t.settled).length;
  return (
    <div className="ip">
      <p className="ip-provenance">
        {kind === "bundle"
          ? "Your bundle"
          : kind === "subject"
            ? "Linked by the sources"
            : kind === "suggestion"
              ? "Suggested by Hercule's triage"
              : `Proposal from ${proposal?.agent ?? "triage"}`}
        {" · "}
        {things.length} things in {sources.join(", ")}
      </p>
      {kind === "bundle" ? (
        <input
          className="ip-title-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => renameBundle(bundle!.id, name)}
          aria-label="Bundle name"
        />
      ) : (
        <h2 className="ip-title">{title}</h2>
      )}
      {why ? <p className="ip-why">{why}</p> : null}
      <p className="ip-muted">
        {asks > 0 ? `${String(asks)} of them wait on you.` : "Nothing in it waits on you."}
      </p>
      <div className="ip-members">
        {things.map((t) => (
          <div key={t.id} className="ip-member">
            <button type="button" onClick={() => onFocus(t.id)}>
              <ThingCard thing={t} size="compact" />
            </button>
            {kind === "bundle" ? (
              <button
                type="button"
                className="ip-remove"
                onClick={() => removeFromBundle(bundle!.id, t.id)}
                title="Take it out of the bundle"
              >
                ✕
              </button>
            ) : null}
          </div>
        ))}
      </div>
      <footer className="ip-answers">
        {kind === "suggestion" ? (
          <>
            <button
              type="button"
              className="ip-answer"
              onClick={() => dismissSuggestion(suggestion!.id)}
            >
              Not related
            </button>
            <span className="ip-push" />
            <button
              type="button"
              className="ip-primary"
              onClick={() => acceptSuggestion(suggestion!.id, things[0]?.title ?? "Bundle")}
            >
              Bundle them
            </button>
          </>
        ) : kind === "proposal" ? (
          <>
            <button
              type="button"
              className="ip-answer"
              onClick={() => settleProposal(proposal!.id)}
            >
              Dismiss
            </button>
            <span className="ip-push" />
            <button
              type="button"
              className="ip-answer"
              onClick={() => {
                createTask({ title, things, lane: "monorepo", withThread: false });
                settleProposal(proposal!.id);
              }}
            >
              Accept
            </button>
            <button
              type="button"
              className="ip-primary"
              onClick={() => {
                settleProposal(proposal!.id);
                openDraft({
                  ids: things.map((t) => t.id),
                  title,
                  origin: { type: "proposal", title },
                });
              }}
            >
              Accept and start a thread
            </button>
          </>
        ) : (
          <>
            {kind === "bundle" ? (
              <button type="button" className="ip-answer" onClick={() => ungroup(bundle!.id)}>
                Ungroup
              </button>
            ) : null}
            <span className="ip-push" />
            <button
              type="button"
              className="ip-answer"
              onClick={() =>
                createTask({ title: name, things, lane: "monorepo", withThread: false })
              }
            >
              Make a Task <kbd>M</kbd>
            </button>
            <button
              type="button"
              className="ip-primary"
              onClick={() =>
                openDraft({
                  ids: things.map((t) => t.id),
                  title: name,
                  origin: kind === "bundle" ? { type: "bundle", name } : { type: "selection" },
                })
              }
            >
              Start a thread on all {things.length} <kbd>T</kbd>
            </button>
          </>
        )}
      </footer>
    </div>
  );
}

/** Draws one block by its type. A type the app does not know draws one quiet line, never nothing. */
function BlockView({ block }: { readonly block: Block }): JSX.Element {
  switch (block.type) {
    case "text":
      return (
        <section className="ip-block">
          {block.title ? <h3>{block.title}</h3> : null}
          <p className="ip-text">{block.text}</p>
        </section>
      );
    case "messages":
      return (
        <section className="ip-block">
          {block.title ? <h3>{block.title}</h3> : null}
          <ol className="ip-messages">
            {block.messages.map((m, i) => (
              <li key={i} className={m.mentionsYou ? "is-you" : ""}>
                <Avatar name={m.author} size={22} />
                <div>
                  <p>
                    <b>{m.author}</b> <span className="ip-muted">{formatWait(m.atMin)} ago</span>
                  </p>
                  <p>{m.text}</p>
                </div>
              </li>
            ))}
          </ol>
          {block.more ? <p className="ip-muted">and {block.more} more</p> : null}
        </section>
      );
    case "change":
      return (
        <section className="ip-block ip-change">
          <p>
            <code>{block.head}</code> → <code>{block.base}</code>
          </p>
          <p className="ip-muted">
            {block.files} files · <ins>+{formatCount(block.add)}</ins>{" "}
            <del>−{formatCount(block.del)}</del> · {block.checks}
          </p>
        </section>
      );
    case "checks":
      return (
        <section className="ip-block">
          <h3>Checks</h3>
          {block.rows.map((r) => (
            <div key={r.name} className="ip-check">
              <p className={r.state === "failed" ? "is-failed" : ""}>
                {r.state === "failed" ? "✗" : "●"} {r.name}
              </p>
              {r.log ? <pre>{r.log}</pre> : null}
            </div>
          ))}
          <p className="ip-muted">{block.passed} passed</p>
        </section>
      );
    case "fields":
      return (
        <section className="ip-block">
          {block.title ? <h3>{block.title}</h3> : null}
          <dl className="ip-fields">
            {block.fields.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      );
    case "trend":
      return (
        <section className="ip-block">
          <h3>{block.caption}</h3>
          <Sparkline values={block.values} width={360} height={46} />
        </section>
      );
    case "code":
      return (
        <section className="ip-block">
          {block.title ? <h3>{block.title}</h3> : null}
          <pre className="ip-code">{block.lines.join("\n")}</pre>
        </section>
      );
    default:
      return <p className="ip-muted">This part can't be shown here.</p>;
  }
}
