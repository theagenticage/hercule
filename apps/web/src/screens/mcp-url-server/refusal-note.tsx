import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import type { RefusalDescription } from "@hercule/client-core/mcp-servers";
import { buildButtonClassName, Button } from "@hercule/ui";
import { TextParts } from "../text-parts";

/**
 * Draws a refusal of an address in the Add form: the sentence, and the button
 * that leads to where the user can act, when there is one. A button that goes
 * to another screen is a link, and every button first closes the dialog
 * (`onLeave`), because the dialog covers the place it leads to.
 *
 * `onShowOfferRow` opens a Connection's row in the list the dialog sits over.
 */
export function RefusalNote({
  description,
  onLeave,
  onShowOfferRow,
}: {
  readonly description: RefusalDescription;
  readonly onLeave: () => void;
  readonly onShowOfferRow: (contributionId: string, connectionId: string) => void;
}): JSX.Element {
  const { action } = description;
  const className = buildButtonClassName("form", "self-start");
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-card border border-line-soft bg-surface px-3 py-2.5 text-row text-muted"
    >
      <p>
        <TextParts parts={description.sentence} />
      </p>
      {action === null ? null : action.kind === "open-server" ? (
        <Link
          to="/settings/mcp-servers/$id"
          params={{ id: action.mcpServerId }}
          onClick={onLeave}
          className={className}
        >
          {action.label}
        </Link>
      ) : action.kind === "open-connections" ? (
        <Link to="/connections" onClick={onLeave} className={className}>
          {action.label}
        </Link>
      ) : action.kind === "open-plugins" ? (
        <Link to="/settings/plugins" onClick={onLeave} className={className}>
          {action.label}
        </Link>
      ) : (
        <Button
          type="button"
          variant="form"
          className="self-start"
          onClick={() => {
            onLeave();
            onShowOfferRow(action.contributionId, action.connectionId);
          }}
        >
          {action.label}
        </Button>
      )}
    </div>
  );
}
