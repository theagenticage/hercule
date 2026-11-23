/**
 * The small pieces every MCP server screen draws the same way: a server's
 * name with its account, its status word, its switch, and a sentence that
 * holds code spans.
 */
import { Fragment, type JSX } from "react";
import type { McpServerDisplayStatus, TextPart } from "@hercule/client-core/mcp-servers";
import "./mcp-servers.css";

/**
 * Renders a server as every screen writes one: its name, then its account in
 * muted type. `account` is the label of the Connection the server is reached
 * with, such as `hobby`, or `undefined` for a server with none.
 */
export function ServerName({
  name,
  account,
}: {
  readonly name: string;
  readonly account: string | undefined;
}): JSX.Element {
  return (
    <span className="mcp-name">
      <b>{name}</b>
      {account !== undefined && (
        <>
          {" "}
          <span className="mcp-account">{account}</span>
        </>
      )}
    </span>
  );
}

/** What `ServerStatus` needs of a server: the fields of `McpServerView` that tell its status. */
interface ServerStatusProps {
  readonly displayStatus: McpServerDisplayStatus;
  /** The status as one word, such as "needs sign-in". */
  readonly word: string;
  /** Whether the status is one that needs the user. */
  readonly failing: boolean;
  /** The reason for a failing status, shown as the tooltip. */
  readonly detail: string | null;
}

/**
 * Renders a server's status as the Connections table draws a Connection's
 * health: quiet when fine, the app's spinner while it is being checked, and
 * `--fail` ink with a red dot, and the reason as the tooltip, while it needs
 * the user.
 */
export function ServerStatus({
  displayStatus,
  word,
  failing,
  detail,
}: ServerStatusProps): JSX.Element {
  if (displayStatus === "checking") {
    return (
      <span className="mcp-status">
        <span className="spin" />
        {word}
      </span>
    );
  }
  if (failing) {
    return (
      <span className="mcp-status mcp-status--fail" title={detail ?? undefined}>
        <i className="dot dot--fail" />
        {word}
      </span>
    );
  }
  return (
    <span className={displayStatus === "off" ? "mcp-status mcp-status--off" : "mcp-status"}>
      {word}
    </span>
  );
}

/**
 * Renders a server's on and off switch. While `busy`, a write is running: the
 * switch keeps the focus and a press does nothing, so a second press cannot
 * start a second write.
 */
export function ServerSwitch({
  on,
  label,
  busy,
  onFlip,
}: {
  readonly on: boolean;
  /** The switch's accessible name, such as "Offer sentry work to threads". */
  readonly label: string;
  readonly busy: boolean;
  readonly onFlip: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      className="toggle mcp-switch"
      aria-checked={on}
      aria-label={label}
      aria-disabled={busy}
      onClick={() => {
        if (!busy) onFlip();
      }}
    />
  );
}

/** Renders `parts` as one run of text, with each code part as a code span. */
export function TextParts({ parts }: { readonly parts: readonly TextPart[] }): JSX.Element {
  return (
    <>
      {parts.map((part, at) =>
        part.code ? <code key={at}>{part.text}</code> : <Fragment key={at}>{part.text}</Fragment>,
      )}
    </>
  );
}
