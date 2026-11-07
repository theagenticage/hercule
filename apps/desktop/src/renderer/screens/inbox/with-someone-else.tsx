import { useId, useState, type JSX } from "react";
import type { PluginIdentity } from "@hercule/client-core";
import type { ColumnRow } from "@hercule/client-core/inbox";
import { RequestCard } from "./request-card";

/**
 * Renders "With someone else" at the foot of the Requests column: the cards
 * that have a live Task, behind a disclosure with its count. They open in
 * place, under the title, and the page simply gets longer. Nothing is drawn
 * for no cards.
 *
 * The disclosure is a button that says whether it is open. Whether it is open
 * is this component's own client state: it closes when the user leaves the
 * Inbox.
 */
export function WithSomeoneElse({
  rows,
  plugins,
}: {
  readonly rows: readonly ColumnRow[];
  readonly plugins: readonly PluginIdentity[];
}): JSX.Element | null {
  const [isOpen, setIsOpen] = useState(false);
  const listId = useId();
  if (rows.length === 0) return null;
  return (
    <section className="inbox-else" data-open={isOpen ? "" : undefined}>
      <button
        type="button"
        className="inbox-else-toggle"
        aria-expanded={isOpen}
        aria-controls={listId}
        onClick={() => {
          setIsOpen(!isOpen);
        }}
      >
        <i className="inbox-else-chevron" />
        <span>With someone else</span>
        <small>{rows.length}</small>
      </button>
      {isOpen && (
        <div id={listId} className="inbox-else-cards" role="list">
          {rows.map((row, index) => (
            <RequestCard
              key={row.card.id}
              card={row.card}
              homeName={row.homeName}
              plugins={plugins}
              step={index}
            />
          ))}
        </div>
      )}
    </section>
  );
}
