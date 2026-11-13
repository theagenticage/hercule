/**
 * The blocks of a thing or a signal as the Inbox's pane draws them (spec 17
 * §The pane): text, messages, a change, checks, fields, a trend and code, and
 * one quiet line for a block of a type this app does not know. Intake draws
 * the same blocks in its own look in `signal-blocks.tsx`; the three blocks
 * that are alike in both come from `inbox-blocks-parts.tsx`.
 */
import type { JSX } from "react";
import type {
  Block,
  ChangeBlock,
  ChecksBlock,
  MessagesBlock,
  ThreadMessage,
} from "@hercule/contract";
import { formatMessageTime, isKnownBlock, UNKNOWN_BLOCK_TEXT } from "@hercule/client-core";
import { ArrowIcon } from "../../icons/arrow";
import { BranchIcon } from "../../icons/branch";
import { ClockIcon } from "../../icons/clock";
import { CloseIcon } from "../../icons/close";
import { Markdown } from "../session/markdown";
import { CodeBlockView, FieldsBlockView, TrendBlockView } from "./inbox-blocks-parts";
import "./inbox-blocks.css";

/** Returns `count` and the noun, made plural when the count is not one: "1 file", "3 files". */
const formatCount = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? "" : "s"}`;

/**
 * Renders blocks one under the other in order. Times are shown in
 * `timezone`, and the trend counts back from `now`. Draws nothing at all for no blocks, so the caller's spacing
 * never frames an empty space.
 */
export function InboxBlocks({
  blocks,
  timezone,
  now,
}: {
  readonly blocks: ReadonlyArray<Block>;
  readonly timezone: string;
  /** The moment times are counted back from. */
  readonly now: Date;
}): JSX.Element | null {
  if (blocks.length === 0) return null;
  return (
    <div className="bks">
      {blocks.map((block, index) => (
        // Blocks hold no id and never change order, so the position is the block's identity.
        <InboxBlock key={index} block={block} timezone={timezone} now={now} />
      ))}
    </div>
  );
}

/** Renders one block, or the one quiet line for a type this app does not know. */
function InboxBlock({
  block,
  timezone,
  now,
}: {
  readonly block: Block;
  readonly timezone: string;
  readonly now: Date;
}): JSX.Element {
  if (!isKnownBlock(block)) return <p className="bk-fine">{UNKNOWN_BLOCK_TEXT}</p>;
  switch (block.type) {
    case "text":
      return (
        <section className="bk">
          <div className="bk-text b-words">
            <Markdown text={block.markdown} inlineImages />
          </div>
        </section>
      );
    case "messages":
      return <MessagesBlockView block={block} timezone={timezone} now={now} />;
    case "change":
      return <ChangeBlockView block={block} />;
    case "checks":
      return <ChecksBlockView block={block} />;
    case "fields":
      return <FieldsBlockView block={block} />;
    case "trend":
      return <TrendBlockView block={block} now={now} />;
    case "code":
      return <CodeBlockView block={block} />;
  }
}

/**
 * Renders a thread's messages, oldest first, each with the first letter of
 * its author's name in a circle. The first message is always kept, so "and N
 * more" for the messages the producer left out sits right after it.
 */
function MessagesBlockView({
  block,
  timezone,
  now,
}: {
  readonly block: MessagesBlock;
  readonly timezone: string;
  readonly now: Date;
}): JSX.Element {
  const [first, ...rest] = block.messages;
  return (
    <ol className="bk bk-msgs">
      <Message message={first!} timezone={timezone} now={now} />
      {block.omitted > 0 && <li className="bk-omitted">and {block.omitted} more</li>}
      {rest.map((message, index) => (
        // The messages hold no id and never change order.
        <Message key={index} message={message} timezone={timezone} now={now} />
      ))}
    </ol>
  );
}

/**
 * Renders one message: the author's initial, name, the time, the file and
 * line of a review comment, the text as markdown, and under it the
 * attachments' names and "Read the rest" when the producer cut the text. A
 * message that mentions the user carries the marigold rule.
 */
function Message({
  message,
  timezone,
  now,
}: {
  readonly message: ThreadMessage;
  readonly timezone: string;
  readonly now: Date;
}): JSX.Element {
  const { author, location, attachments } = message;
  const time = formatMessageTime(new Date(message.at), timezone, now);
  const readTheRest = message.truncated === true && message.url !== undefined;
  return (
    <li className={message.mentionsYou === true ? "is-you" : undefined}>
      <span className="bk-av" aria-hidden="true">
        {Array.from(author.name.trim())[0]?.toUpperCase()}
      </span>
      <div>
        <p className="bk-msg-head">
          <b>{author.name}</b>
          {location !== undefined && (
            <span className="bk-where">
              {location.line === undefined ? location.path : `${location.path}:${location.line}`}
            </span>
          )}
          {time !== undefined && <time dateTime={message.at}>{time}</time>}
        </p>
        <div className="bk-msg-text b-words">
          <Markdown text={message.text} breaks inlineImages />
        </div>
        {(attachments !== undefined || readTheRest) && (
          <p className="bk-fine">
            {attachments?.map((attachment) => attachment.name).join(", ")}
            {attachments !== undefined && readTheRest && " · "}
            {readTheRest && (
              <a href={message.url} target="_blank" rel="noreferrer">
                Read the rest
              </a>
            )}
          </p>
        )}
      </div>
    </li>
  );
}

/** Returns the summary of a change's checks, the worst first: "1 failing, 2 pending, 11 passed". */
const describeChecks = (checks: NonNullable<ChangeBlock["checks"]>): string =>
  [
    ...(checks.failed > 0 ? [`${String(checks.failed)} failing`] : []),
    ...(checks.pending > 0 ? [`${String(checks.pending)} pending`] : []),
    ...(checks.passed > 0 ? [`${String(checks.passed)} passed`] : []),
  ].join(", ");

/** Renders a change: its branch pair, its size, and its checks' summary. */
function ChangeBlockView({ block }: { readonly block: ChangeBlock }): JSX.Element {
  const checks = block.checks === undefined ? "" : describeChecks(block.checks);
  return (
    <section className="bk bk-change">
      <p className="bk-branch">
        <BranchIcon size={14} />
        <code>{block.from}</code>
        <ArrowIcon size={12} />
        <code>{block.to}</code>
      </p>
      <p className="bk-diff">
        <span>{formatCount(block.files, "file")}</span>
        <span className="ins">+{block.additions}</span>
        <span className="del">−{block.deletions}</span>
        {block.commits !== undefined && <span>{formatCount(block.commits, "commit")}</span>}
        {checks !== "" && <span className="bk-checks">{checks}</span>}
      </p>
    </section>
  );
}

/**
 * Renders the failed and pending checks, one row each with its log under it
 * when it has one, then the passed count and "and N more" for the rows the
 * producer left out.
 */
function ChecksBlockView({ block }: { readonly block: ChecksBlock }): JSX.Element {
  const fine = [
    ...(block.passed > 0 ? [`${String(block.passed)} passed`] : []),
    ...(block.omitted > 0 ? [`and ${String(block.omitted)} more`] : []),
  ].join(" · ");
  return (
    <section className="bk">
      <h3>Checks</h3>
      {block.rows.map((row, index) => (
        // Two checks can share a name, and the rows never change order.
        <div key={index} className="bk-check">
          <p className={`is-${row.state}`}>
            {row.state === "failed" ? <CloseIcon size={13} /> : <ClockIcon size={13} />}
            {row.url === undefined ? (
              row.name
            ) : (
              <a href={row.url} target="_blank" rel="noreferrer">
                {row.name}
              </a>
            )}
          </p>
          {row.log !== undefined && <pre>{row.log}</pre>}
        </div>
      ))}
      {fine !== "" && <p className="bk-fine">{fine}</p>}
    </section>
  );
}
