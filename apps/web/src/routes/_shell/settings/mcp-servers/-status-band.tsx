import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import { buildButtonClassName, Button, WorkingMark } from "@hercule/ui";
import { decideStatusBand, type McpServerView } from "@hercule/client-core/mcp-servers";

/**
 * The band under the heading of a server's page: what the status means and the
 * one thing to do about it. It shows for every status but ready.
 *
 * - A server that needs sign-in offers its Connection's Reconnect. The button
 *   leads to the Connections screen, which opens that Connection's panel.
 * - An unreachable server, or one in error, offers Check now.
 * - A band that needs the user has a failure dot and a heading in the failure
 *   colour. The rest is as quiet as a line of text.
 *
 * Presentational: pressing Check now calls `onCheck`, and `checkPending`
 * says the check was asked for and has not been answered.
 */
export function StatusBand({
  view,
  onCheck,
  checkPending,
}: {
  readonly view: McpServerView;
  readonly onCheck: () => void;
  readonly checkPending: boolean;
}): JSX.Element | null {
  const band = decideStatusBand(view);
  if (band === null) return null;
  const { action } = band;
  return (
    <div
      role="status"
      className="flex max-w-[568px] items-start gap-2.5 rounded-card border border-line-soft bg-surface px-3 py-2.5 text-row"
    >
      {band.tone === "fail" ? (
        <span aria-hidden="true" className="mt-[7px] size-1.5 shrink-0 rounded-full bg-fail" />
      ) : view.displayStatus === "checking" ? (
        <WorkingMark className="mt-1" />
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-muted">
          {band.heading === null ? null : (
            <b className={band.tone === "fail" ? "font-emph text-fail" : "font-emph text-ink"}>
              {band.heading}{" "}
            </b>
          )}
          {band.text}
        </p>
        {band.detail === null ? null : <p className="text-fine text-muted">{band.detail}</p>}
      </div>
      {action === null ? null : action.kind === "reconnect" ? (
        <Link
          to="/connections"
          search={{ reconnect: action.connectionId }}
          className={buildButtonClassName("form", "shrink-0")}
        >
          {action.label}
        </Link>
      ) : (
        <Button variant="form" className="shrink-0" aria-disabled={checkPending} onClick={onCheck}>
          {action.label}
        </Button>
      )}
    </div>
  );
}
