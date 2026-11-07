import type { JSX } from "react";
import type { PluginIdentity } from "@hercule/client-core";
import { describeClaim, describeHint } from "@hercule/client-core/desk";
import type { TuckedLine } from "@hercule/client-core/inbox";
import { LinkIcon } from "../../icons/link";

/**
 * Renders the quiet lines under a card, each a whole-line button: the
 * references found in its text, and what it is linked to.
 *
 * - A hint ("Mentions OPS-47", "Mentioned in #6263") is a reference found in
 *   text. It joins nothing. `Link them`, which shows on hover, links the pair:
 *   the button carries the two refs (`data-link-from`, `data-link-to`) for the
 *   page's click. It is not a card and not a stop of the keys. The same move is
 *   in the open card.
 * - A peer line ("Linked to #6263") says what a request is linked to. A click
 *   opens the thing, when it can be opened (`data-open-id`).
 *
 * The words of each claim are the tooltip. `leadId` and `leadIdentifier` are
 * the card the lines lie under: the id keys the line for the page's motion, and
 * the identifier names whose text holds a reference.
 */
export function LinkLines({
  leadId,
  leadIdentifier,
  lines,
  plugins,
}: {
  readonly leadId: string;
  readonly leadIdentifier: string;
  readonly lines: readonly TuckedLine[];
  readonly plugins: readonly PluginIdentity[];
}): JSX.Element {
  return (
    <>
      {lines.map((line) => {
        if (line._tag === "peer") {
          const words = describeClaim(line.claim, plugins);
          return (
            <button
              key={`peer:${line.otherRef}`}
              type="button"
              tabIndex={-1}
              className="inbox-hint"
              data-lead-id={leadId}
              data-hint-ref={line.otherRef}
              data-open-id={line.openId}
              title={words}
              aria-description={words}
            >
              <LinkIcon size={12} />
              <span>Linked to {line.reference}</span>
            </button>
          );
        }
        // The end whose text holds the reference is the card itself unless the line names it as the other end.
        const mentioner = line.fromRef === line.otherRef ? line.reference : leadIdentifier;
        const words = describeHint(line, mentioner);
        return (
          <button
            key={`hint:${line.fromRef}>${line.toRef}`}
            type="button"
            tabIndex={-1}
            className="inbox-hint"
            data-lead-id={leadId}
            data-hint-ref={line.otherRef}
            data-link-from={line.fromRef}
            data-link-to={line.toRef}
            title={words}
            aria-description={words}
          >
            <LinkIcon size={12} />
            <span>
              {line.word} {line.reference}
            </span>
            <b>Link them</b>
          </button>
        );
      })}
    </>
  );
}
