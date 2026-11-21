import type { JSX } from "react";
import type { McpServerView } from "@hercule/client-core/mcp-servers";
import { cn, WorkingMark } from "@hercule/ui";

/**
 * Draws the status of an MCP Server as one word:
 *
 * - a failing status (needs sign-in, unreachable, error) is in the failure
 *   colour behind a dot, with the server's own reason as the tooltip;
 * - `checking` carries the app's working mark;
 * - `ready` is plain, and `off` is fainter, because it is the user's choice.
 *
 * A `null` view is a Connection whose server was never switched on: it has no
 * record yet and reads "off".
 */
export function McpServerStatusWord({
  view,
  className,
}: {
  readonly view: McpServerView | null;
  readonly className?: string;
}): JSX.Element {
  if (view === null) return <span className={cn("text-fine text-faint", className)}>off</span>;
  return (
    <span
      title={view.statusDetail ?? undefined}
      className={cn(
        "inline-flex items-center gap-1.5 text-fine",
        view.failing ? "text-fail" : view.displayStatus === "off" ? "text-faint" : "text-muted",
        className,
      )}
    >
      {view.failing ? (
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-fail" />
      ) : null}
      {view.displayStatus === "checking" ? <WorkingMark /> : null}
      {view.statusWord}
    </span>
  );
}
