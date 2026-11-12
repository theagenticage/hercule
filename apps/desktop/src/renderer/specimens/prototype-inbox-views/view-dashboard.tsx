/**
 * PROTOTYPE, throwaway. View C, the Dashboard (round four of the Layout): the
 * page the user tunes for glancing. Rogier, 2026-11-10: it cannot show
 * everything; its point is filtering and sorting that know each source's own
 * concepts, so that it is better at dashboards than all the sources combined.
 *
 * A block is a question and a way to answer it at a glance:
 *
 * - the question is a `Query` over the fields plugins declare (fields.ts):
 *   Sentry's team, level, events and release, a pull request's checks and
 *   size, and the core's own fields that cross sources ("tied to my open pull
 *   request", "tied to a ticket");
 * - the answer is a number (with what is new since you looked), a breakdown
 *   by any field (click a bar to narrow), a short list, or cards.
 *
 * "Edit" opens the block's builder: pick sources, then click values that the
 * data really has (with counts), or presets for numbers and ages. A block can
 * pin a workflow: a button that starts it on what the block finds. The page
 * stores the workflow's id and that its input is this block's result.
 */
import { useState, type DragEvent, type JSX } from "react";
import { ThingCard } from "./cards";
import {
  countValues,
  describeClause,
  findField,
  listFields,
  runQuery,
  type Clause,
  type Field,
  type Query,
} from "./fields";
import { Desk, Mark } from "./parts";
import { startWorkflow, toggleSelected, useWork } from "./start";
import "./view-dashboard.css";
import { Selectable } from "./view-work";
import { WORKFLOWS, type Workflow } from "./work";
import { formatCount, formatWait, isPressing, type KindId, type Thing, type World } from "./world";

type Look = "number" | "breakdown" | "list" | "cards";
type Span = 3 | 4 | 6 | 8 | 12;

interface Block {
  readonly id: string;
  readonly title: string;
  readonly query: Query;
  readonly look: Look;
  readonly groupBy?: string | undefined;
  readonly limit: number;
  readonly span: Span;
  /** The id of a pinned workflow, started on what the block finds. */
  readonly pin?: string | undefined;
}

const q = (kinds: readonly KindId[], clauses: readonly Clause[]): Query => ({
  kinds,
  clauses,
  text: "",
});

const DEFAULT_BLOCKS: readonly Block[] = [
  {
    id: "b1",
    title: "Waiting on me",
    query: q([], [{ key: "waits", op: "is", value: true }]),
    look: "number",
    limit: 3,
    span: 3,
  },
  {
    id: "b2",
    title: "Checkout errors getting worse",
    query: q(
      ["sentry/issue"],
      [
        { key: "team", op: "is", value: "Checkout" },
        { key: "issue", op: "is", value: "Escalating" },
        { key: "issue", op: "is", value: "Regressed" },
        { key: "issue", op: "is", value: "New" },
      ],
    ),
    look: "number",
    limit: 3,
    span: 3,
    pin: "wf-triage",
  },
  {
    id: "b3",
    title: "Reviews waiting a day",
    query: q(
      ["github/pull-request"],
      [
        { key: "review", op: "is", value: "Requested from me" },
        { key: "waiting", op: "gt", value: 24 * 60 },
      ],
    ),
    look: "number",
    limit: 3,
    span: 3,
  },
  {
    id: "b4",
    title: "Customers waiting on me",
    query: q(["intercom/conversation"], [{ key: "move", op: "is", value: "Mine" }]),
    look: "number",
    limit: 3,
    span: 3,
  },
  {
    id: "b5",
    title: "Errors by team",
    query: q(["sentry/issue"], [{ key: "issue", op: "not", value: "Resolved" }]),
    look: "breakdown",
    groupBy: "team",
    limit: 8,
    span: 6,
    pin: "wf-digest",
  },
  {
    id: "b6",
    title: "My pull requests by checks",
    query: q(["github/pull-request"], [{ key: "author", op: "is", value: "You" }]),
    look: "breakdown",
    groupBy: "checks",
    limit: 6,
    span: 6,
  },
  {
    id: "b7",
    title: "Errors tied to my open pull requests",
    query: q(["sentry/issue"], [{ key: "my-pr", op: "is", value: true }]),
    look: "cards",
    limit: 3,
    span: 8,
    pin: "wf-fix",
  },
  {
    id: "b8",
    title: "Top 5 emails",
    query: q(["gmail/thread"], [{ key: "waits", op: "is", value: true }]),
    look: "list",
    limit: 5,
    span: 4,
  },
  {
    id: "b9",
    title: "My pull requests with failing checks",
    query: q(
      ["github/pull-request"],
      [
        { key: "author", op: "is", value: "You" },
        { key: "checks", op: "is", value: "Failing" },
      ],
    ),
    look: "list",
    limit: 5,
    span: 6,
    pin: "wf-checks",
  },
  {
    id: "b10",
    title: "Customers waiting on a bug",
    query: q(
      ["intercom/conversation", "gmail/thread"],
      [
        { key: "ticket", op: "is", value: true },
        { key: "move", op: "is", value: "Mine" },
      ],
    ),
    look: "list",
    limit: 5,
    span: 6,
    pin: "wf-reply",
  },
];

const PRESETS: Record<"number" | "age", readonly (readonly [string, Clause["op"], number])[]> = {
  number: [
    ["over 10", "gt", 10],
    ["over 100", "gt", 100],
    ["over 1,000", "gt", 1000],
    ["under 10", "lt", 10],
  ],
  age: [
    ["under 1h", "lt", 60],
    ["under 1d", "lt", 24 * 60],
    ["over 1d", "gt", 24 * 60],
    ["over 1w", "gt", 7 * 24 * 60],
  ],
};

export function ViewDashboard({ world }: { readonly world: World }): JSX.Element {
  const [blocks, setBlocks] = useState<readonly Block[]>(DEFAULT_BLOCKS);
  const [editing, setEditing] = useState<string | null>(null);
  const [arranging, setArranging] = useState(false);
  const [dragged, setDragged] = useState<string | null>(null);
  const live = world.things.filter((t) => !t.settled && !t.lapsed);
  const update = (id: string, change: Partial<Block>): void =>
    setBlocks(blocks.map((b) => (b.id === id ? { ...b, ...change } : b)));
  const briefing = WORKFLOWS.find((w) => w.input.type === "none")!;

  const tools = (
    <div className="db-tools">
      <button
        type="button"
        className="tool"
        onClick={() => startWorkflow(briefing, { type: "none" })}
      >
        ▶ {briefing.name}
      </button>
      <button
        type="button"
        className={`tool${arranging ? " is-on" : ""}`}
        aria-pressed={arranging}
        onClick={() => setArranging(!arranging)}
      >
        {arranging ? <b>Done arranging</b> : "Arrange"}
      </button>
      <button
        type="button"
        className="tool"
        onClick={() => {
          const id = `b${String(Date.now())}`;
          setBlocks([
            ...blocks,
            { id, title: "New block", query: q([], []), look: "number", limit: 5, span: 6 },
          ]);
          setEditing(id);
        }}
      >
        + Add block
      </button>
    </div>
  );

  return (
    <Desk tools={tools} className="db-desk">
      <div className={`db${arranging ? " is-arranging" : ""}`}>
        {blocks.map((block) => (
          <section
            key={block.id}
            className={`db-block${dragged === block.id ? " is-dragged" : ""}${editing === block.id ? " is-editing" : ""}`}
            style={{ gridColumn: `span ${String(editing === block.id ? 12 : block.span)}` }}
            draggable={arranging}
            onDragStart={() => setDragged(block.id)}
            onDragEnd={() => setDragged(null)}
            onDragOver={(e: DragEvent) => {
              if (arranging) e.preventDefault();
            }}
            onDrop={(e: DragEvent) => {
              e.preventDefault();
              if (!dragged || dragged === block.id) return;
              const moving = blocks.find((b) => b.id === dragged)!;
              const rest = blocks.filter((b) => b.id !== dragged);
              const at = rest.findIndex((b) => b.id === block.id);
              setBlocks([...rest.slice(0, at), moving, ...rest.slice(at)]);
              setDragged(null);
            }}
          >
            <BlockView
              block={block}
              world={world}
              live={live}
              arranging={arranging}
              isEditing={editing === block.id}
              onEdit={() => setEditing(editing === block.id ? null : block.id)}
              onChange={(c) => update(block.id, c)}
              onRemove={() => setBlocks(blocks.filter((b) => b.id !== block.id))}
            />
          </section>
        ))}
      </div>
    </Desk>
  );
}

function BlockView({
  block,
  world,
  live,
  arranging,
  isEditing,
  onEdit,
  onChange,
  onRemove,
}: {
  readonly block: Block;
  readonly world: World;
  readonly live: readonly Thing[];
  readonly arranging: boolean;
  readonly isEditing: boolean;
  readonly onEdit: () => void;
  readonly onChange: (change: Partial<Block>) => void;
  readonly onRemove: () => void;
}): JSX.Element {
  const { selection } = useWork();
  const found = runQuery(live, block.query, world).sort(
    (a, b) => Number(isPressing(b)) - Number(isPressing(a)) || b.waitMin - a.waitMin,
  );
  const pinned = block.pin ? WORKFLOWS.find((w) => w.id === block.pin) : undefined;
  const marks = [
    ...new Set(
      (block.query.kinds.length > 0 ? block.query.kinds : []).map(
        (k) => world.kinds.find((x) => x.id === k)!.source,
      ),
    ),
  ];
  const fresh = found.filter((t) => t.isNew).length;
  return (
    <>
      <header className="db-head">
        {arranging ? <span className="db-grip">⠿</span> : null}
        <span className="db-marks">
          {marks.map((s) => (
            <Mark key={s} source={s} size={13} />
          ))}
        </span>
        {isEditing ? (
          <input
            className="db-title-input"
            value={block.title}
            onChange={(e) => onChange({ title: e.target.value })}
            aria-label="Block title"
          />
        ) : (
          <h2>{block.title}</h2>
        )}
        <span className="db-push" />
        {pinned && !isEditing && block.span >= 6 ? (
          <PinButton workflow={pinned} things={found} block={block} />
        ) : null}
        {arranging ? (
          <span className="db-choice">
            {([3, 4, 6, 8, 12] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={block.span === s}
                onClick={() => onChange({ span: s })}
              >
                {{ 3: "S", 4: "M", 6: "L", 8: "XL", 12: "Full" }[s]}
              </button>
            ))}
          </span>
        ) : null}
        <button type="button" className="db-edit" onClick={onEdit} aria-expanded={isEditing}>
          {isEditing ? "Done" : "Edit"}
        </button>
        {arranging || isEditing ? (
          <button type="button" className="db-edit" onClick={onRemove} aria-label="Remove block">
            ✕
          </button>
        ) : null}
      </header>
      {block.query.clauses.length > 0 && !isEditing ? (
        <p className="db-query">
          {block.query.clauses.map((c, i) => (
            <span key={i}>{describeClause(c)}</span>
          ))}
        </p>
      ) : null}
      {isEditing ? <Builder block={block} world={world} live={live} onChange={onChange} /> : null}
      {pinned && !isEditing && block.span < 6 ? (
        <span className="db-pin-under">
          <PinButton workflow={pinned} things={found} block={block} />
        </span>
      ) : null}
      {block.look === "number" ? (
        <div className="db-number">
          <b>{formatCount(found.length)}</b>
          <span>
            {fresh > 0 ? `${String(fresh)} new since you looked` : "nothing new since you looked"}
          </span>
          <ol className="db-mini">
            {found.slice(0, block.limit).map((t) => (
              <li key={t.id}>
                <Mark source={t.source} size={12} />
                <span>{t.title}</span>
                <em className={isPressing(t) ? "is-long" : ""}>{formatWait(t.waitMin)}</em>
              </li>
            ))}
          </ol>
        </div>
      ) : block.look === "breakdown" ? (
        <Breakdown
          field={findField(block.groupBy ?? "source")!}
          things={found}
          world={world}
          limit={block.limit}
          onNarrow={(value) =>
            onChange({
              query: {
                ...block.query,
                clauses: [
                  ...block.query.clauses,
                  { key: block.groupBy ?? "source", op: "is", value },
                ],
              },
            })
          }
        />
      ) : block.look === "list" ? (
        <ol className="db-list">
          {found.slice(0, block.limit).map((t) => (
            <li
              key={t.id}
              className={selection.includes(t.id) ? "is-selected" : ""}
              onClick={() => toggleSelected(t.id)}
            >
              <Mark source={t.source} size={13} />
              <b>{t.face.sender ?? t.person}</b>
              <span>{t.title}</span>
              <em className={isPressing(t) ? "is-long" : ""}>{formatWait(t.waitMin)}</em>
            </li>
          ))}
        </ol>
      ) : (
        <div className="db-cards">
          {found.slice(0, block.limit).map((t) => (
            <Selectable key={t.id} thing={t} selected={selection.includes(t.id)}>
              <ThingCard thing={t} selected={selection.includes(t.id)} />
            </Selectable>
          ))}
          {found.length === 0 ? <p className="db-muted">Nothing right now.</p> : null}
        </div>
      )}
    </>
  );
}

function PinButton({
  workflow,
  things,
  block,
}: {
  readonly workflow: Workflow;
  readonly things: readonly Thing[];
  readonly block: Block;
}): JSX.Element {
  const label =
    workflow.input.type === "view"
      ? `${workflow.name}`
      : workflow.input.type === "each"
        ? `${workflow.name} (${String(things.length)} runs)`
        : `${workflow.name} (${String(things.length)})`;
  return (
    <button
      type="button"
      className="db-pin"
      disabled={things.length === 0}
      title={`Pinned on this block: starts "${workflow.name}" on what the block finds`}
      onClick={() => {
        if (workflow.input.type === "view")
          startWorkflow(workflow, { type: "view", label: block.title, count: things.length });
        else startWorkflow(workflow, { type: "things", things });
      }}
    >
      ▶ {label}
    </button>
  );
}

function Breakdown({
  field,
  things,
  world,
  limit,
  onNarrow,
}: {
  readonly field: Field;
  readonly things: readonly Thing[];
  readonly world: World;
  readonly limit: number;
  readonly onNarrow: (value: string) => void;
}): JSX.Element {
  const values = countValues(field, things, world).slice(0, limit);
  const max = Math.max(1, ...values.map(([, n]) => n));
  return (
    <div className="db-breakdown">
      <p className="db-muted">
        {formatCount(things.length)} by {field.label.toLowerCase()} · click a bar to narrow
      </p>
      {values.map(([v, n]) => {
        const late = things.filter(
          (t) => String(field.read(t, world)) === v && isPressing(t),
        ).length;
        return (
          <button key={v} type="button" className="db-bar" onClick={() => onNarrow(v)}>
            <span className="db-bar-label">{v}</span>
            <span className="db-bar-track">
              <i style={{ width: `${String((n / max) * 100)}%` }} />
              {late > 0 ? (
                <i className="is-late" style={{ width: `${String((late / max) * 100)}%` }} />
              ) : null}
            </span>
            <span className="db-bar-n">
              {n}
              {late > 0 ? <em> · {late} late</em> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The block's builder: sources, then the fields those sources declare with
 * the values the data really has, then the look, the size and a pinned
 * workflow. Every click shows its effect at once in the block below.
 */
function Builder({
  block,
  world,
  live,
  onChange,
}: {
  readonly block: Block;
  readonly world: World;
  readonly live: readonly Thing[];
  readonly onChange: (change: Partial<Block>) => void;
}): JSX.Element {
  const scoped = runQuery(live, { ...block.query, clauses: [] }, world);
  const fields = listFields(block.query.kinds);
  const toggle = (c: Clause): void => {
    const has = block.query.clauses.some(
      (x) => x.key === c.key && x.op === c.op && x.value === c.value,
    );
    onChange({
      query: {
        ...block.query,
        clauses: has
          ? block.query.clauses.filter(
              (x) => !(x.key === c.key && x.op === c.op && x.value === c.value),
            )
          : [...block.query.clauses, c],
      },
    });
  };
  const isOn = (c: Clause): boolean =>
    block.query.clauses.some((x) => x.key === c.key && x.op === c.op && x.value === c.value);
  const pinnable = WORKFLOWS.filter(
    (w) =>
      w.input.type === "view" ||
      w.input.type === "things" ||
      w.input.type === "each" ||
      (w.input.type === "thing" && block.look === "cards"),
  );
  return (
    <div className="db-builder">
      <div className="db-row">
        <span className="db-label">From</span>
        <span className="db-chips">
          {world.kinds.map((k) => {
            const on = block.query.kinds.includes(k.id);
            return (
              <button
                key={k.id}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  onChange({
                    query: {
                      ...block.query,
                      kinds: on
                        ? block.query.kinds.filter((x) => x !== k.id)
                        : [...block.query.kinds, k.id],
                      clauses: block.query.clauses.filter(
                        (c) => findField(c.key)?.kinds.length === 0,
                      ),
                    },
                  })
                }
              >
                <Mark source={k.source} size={12} />{" "}
                {world.sources.find((s) => s.id === k.source)!.name} {k.noun.toLowerCase()}
              </button>
            );
          })}
        </span>
      </div>
      <div className="db-fields">
        {fields.map((f) => (
          <div key={f.key} className="db-field">
            <span className="db-field-name">
              {f.label}
              <small>{f.owner === "core" ? "" : f.owner}</small>
            </span>
            <span className="db-chips">
              {f.type === "number" || f.type === "age"
                ? PRESETS[f.type].map(([label, op, value]) => (
                    <button
                      key={label}
                      type="button"
                      aria-pressed={isOn({ key: f.key, op, value })}
                      onClick={() => toggle({ key: f.key, op, value })}
                    >
                      {label}
                    </button>
                  ))
                : countValues(f, scoped, world)
                    .slice(0, 10)
                    .map(([v, n]) => {
                      const c: Clause = {
                        key: f.key,
                        op: "is",
                        value: f.type === "bool" ? v === "Yes" : v,
                      };
                      return (
                        <button
                          key={v}
                          type="button"
                          aria-pressed={isOn(c)}
                          onClick={() => toggle(c)}
                        >
                          {v} <small>{n}</small>
                        </button>
                      );
                    })}
            </span>
          </div>
        ))}
      </div>
      <div className="db-row">
        <span className="db-label">Show as</span>
        <span className="db-chips">
          {(["number", "breakdown", "list", "cards"] as const).map((l) => (
            <button
              key={l}
              type="button"
              aria-pressed={block.look === l}
              onClick={() => onChange({ look: l })}
            >
              {{ number: "A number", breakdown: "A breakdown", list: "A list", cards: "Cards" }[l]}
            </button>
          ))}
        </span>
        {block.look === "breakdown" ? (
          <>
            <span className="db-label">by</span>
            <select
              value={block.groupBy ?? "source"}
              onChange={(e) => onChange({ groupBy: e.target.value })}
            >
              {fields
                .filter((f) => f.type === "enum" || f.type === "bool")
                .map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
            </select>
          </>
        ) : null}
        <span className="db-label">How many</span>
        <span className="db-chips">
          {[3, 5, 8, 12].map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={block.limit === n}
              onClick={() => onChange({ limit: n })}
            >
              {n}
            </button>
          ))}
        </span>
      </div>
      <div className="db-row">
        <span className="db-label">Pin</span>
        <span className="db-chips">
          <button
            type="button"
            aria-pressed={block.pin === undefined}
            onClick={() => onChange({ pin: undefined })}
          >
            No workflow
          </button>
          {pinnable.map((w) => (
            <button
              key={w.id}
              type="button"
              aria-pressed={block.pin === w.id}
              onClick={() => onChange({ pin: w.id })}
              title={w.does}
            >
              {w.name}
            </button>
          ))}
        </span>
      </div>
    </div>
  );
}
