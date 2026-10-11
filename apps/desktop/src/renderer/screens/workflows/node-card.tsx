/**
 * The inside of a node's card on the workflow graph: the node's id and kind,
 * one label and value row per field its definition sets, and an agent step's
 * prompt (spec 17 §Workflows, "A step's card").
 */
import type { JSX } from "react";
import type { NodeCard, NodeFact } from "@hercule/client-core/node-details";
import { useListTime } from "./list-time";
import { NodeIcon } from "./node-icon";
import "../thread/menus.css";
import "./node-card.css";

/** Renders the value of a time row, such as "Fri 14:00", kept current by the age clock. */
function TimeValue({
  fact,
  timezone,
}: {
  readonly fact: Extract<NodeFact, { kind: "time" }>;
  readonly timezone: string;
}): JSX.Element {
  // The card is drawn only while it is open, so it is always on screen.
  const text = useListTime(fact.at, timezone, fact.direction, true);
  return <dd>{text}</dd>;
}

/**
 * Renders the inside of `card`: the header with the node's icon, its id and
 * its kind, then its rows and its prompt where it has them. Time rows are
 * shown in `timezone`. `firesOnSchedule` picks the clock over the bolt for a
 * start trigger.
 */
export function NodeCardContent({
  card,
  firesOnSchedule,
  timezone,
}: {
  readonly card: NodeCard;
  readonly firesOnSchedule: boolean;
  readonly timezone: string;
}): JSX.Element {
  return (
    <>
      <div className="pop-h">
        <NodeIcon kind={card.kind} firesOnSchedule={firesOnSchedule} />
        <b>{card.id}</b>
        <span>{card.kindText}</span>
      </div>
      {card.facts.length === 0 ? null : (
        <div className="pop-sec">
          <dl className="node-facts">
            {card.facts.map((fact, index) => (
              // Two rows can share a label, such as two parameters' names; the order is fixed.
              <div key={`${String(index)} ${fact.label}`}>
                <dt>{fact.label}</dt>
                {fact.kind === "time" ? (
                  <TimeValue fact={fact} timezone={timezone} />
                ) : (
                  <dd className={fact.isCode ? "is-code" : undefined} title={fact.value}>
                    {fact.value}
                  </dd>
                )}
              </div>
            ))}
          </dl>
        </div>
      )}
      {card.prompt === undefined ? null : (
        <div className="pop-sec">
          <div className="q-h">Prompt</div>
          <p className="node-prompt">{card.prompt}</p>
        </div>
      )}
    </>
  );
}
