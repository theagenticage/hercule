/**
 * The blocks of the open signal, as spec 10 §9.5 defines them and spec 17
 * §The pane draws them: text, messages, a change and checks, and one quiet
 * line for a block of a type this app does not know.
 */
import { useState, type JSX } from "react";
import type {
  Block,
  ChangeBlock,
  ChecksBlock,
  MessagesBlock,
  Person,
  TaskCreateInput,
  TextBlock,
  ThreadMessage,
} from "@hercule/contract";
import { formatMessageTime, buildInitials, UNKNOWN_BLOCK_TEXT } from "@hercule/client-core";
import { ArrowIcon } from "../../icons/arrow";
import { BranchIcon } from "../../icons/branch";
import { DiffIcon } from "../../icons/diff";
import { Mark } from "../../marks";
import { TasksIcon } from "../../icons/tasks";
import { Markdown } from "../session/markdown";

/** Returns `count` and the noun, made plural when the count is not one: "1 file", "3 files". */
const formatCount = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? "" : "s"}`;

/**
 * Renders a signal's blocks in order, and, on a proposal, the Task that
 * Accept creates. Times are shown in `timezone`.
 */
export function SignalBlocks({
  blocks,
  task,
  timezone,
}: {
  readonly blocks: ReadonlyArray<Block>;
  readonly task: TaskCreateInput | undefined;
  readonly timezone: string;
}): JSX.Element | null {
  if (blocks.length === 0 && task === undefined) return null;
  return (
    <div className="ad-blocks">
      {blocks.map((block, index) => (
        // A signal's blocks hold no id and never change order, so the
        // position is the block's identity.
        <SignalBlock key={index} block={block} timezone={timezone} />
      ))}
      {task !== undefined && <TaskPreview task={task} />}
    </div>
  );
}

/**
 * Renders one block. A block whose type is known always fits that type's
 * schema, because the contract never reads a known type as an unknown block,
 * so each case reads the block as its type.
 */
function SignalBlock({
  block,
  timezone,
}: {
  readonly block: Block;
  readonly timezone: string;
}): JSX.Element {
  switch (block.type) {
    case "text":
      return (
        <div className="b-words">
          <Markdown text={(block as TextBlock).markdown} />
        </div>
      );
    case "messages":
      return <MessagesBlockView block={block as MessagesBlock} timezone={timezone} />;
    case "change":
      return <ChangeBlockView block={block as ChangeBlock} />;
    case "checks":
      return <ChecksBlockView block={block as ChecksBlock} />;
    default:
      return <p className="b-quiet">{UNKNOWN_BLOCK_TEXT}</p>;
  }
}

/**
 * Renders a thread's messages, oldest first. The first message is always
 * kept, so "and N more" for the messages the producer left out sits right
 * after it.
 */
function MessagesBlockView({
  block,
  timezone,
}: {
  readonly block: MessagesBlock;
  readonly timezone: string;
}): JSX.Element {
  const [first, ...rest] = block.messages;
  return (
    <div className="b-thread">
      <Message message={first!} timezone={timezone} />
      {block.omitted > 0 && <p className="b-quiet">and {block.omitted} more</p>}
      {rest.map((message, index) => (
        // The messages hold no id and never change order.
        <Message key={index} message={message} timezone={timezone} />
      ))}
    </div>
  );
}

/** Formats people as their names, joined by commas. */
const formatPeople = (people: ReadonlyArray<Person>): string =>
  people.map((person) => person.name).join(", ");

/**
 * Renders one message: the author's avatar, name and handle, the file and
 * line of a review comment, the time, a mail's recipients, the text as
 * markdown, and under it the attachments' names and "Read the rest" when
 * the producer cut the text.
 */
function Message({
  message,
  timezone,
}: {
  readonly message: ThreadMessage;
  readonly timezone: string;
}): JSX.Element {
  const { author, location, recipients, attachments } = message;
  const time = formatMessageTime(new Date(message.at), timezone, new Date());
  const readTheRest = message.truncated === true && message.url !== undefined;
  return (
    <div className={message.mentionsYou === true ? "b-msg is-you" : "b-msg"}>
      <div className="b-msg-head">
        <Avatar person={author} />
        <b>{author.name}</b>
        {author.handle !== undefined && <span className="mono">{author.handle}</span>}
        {location !== undefined && (
          <span className="mono">
            {location.line === undefined ? location.path : `${location.path}:${location.line}`}
          </span>
        )}
        {time !== undefined && <time dateTime={message.at}>{time}</time>}
      </div>
      {recipients !== undefined && (
        <p className="b-msg-meta">
          To {formatPeople(recipients.to)}
          {recipients.cc.length > 0 && ` · Cc ${formatPeople(recipients.cc)}`}
        </p>
      )}
      <div className="b-msg-text b-words">
        <Markdown text={message.text} breaks />
      </div>
      {(attachments !== undefined || readTheRest) && (
        <p className="b-msg-meta">
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
  );
}

/**
 * Renders a person's avatar, or their initials when they have none or the
 * image fails to load. The name is beside it, so the avatar is decorative.
 */
function Avatar({ person }: { readonly person: Person }): JSX.Element {
  const [failed, setFailed] = useState(false);
  return (
    <span className="b-avatar" aria-hidden="true">
      {person.avatarUrl === undefined || failed ? (
        buildInitials(person.name)
      ) : (
        <img
          src={person.avatarUrl}
          alt=""
          onError={() => {
            setFailed(true);
          }}
        />
      )}
    </span>
  );
}

/**
 * Renders a change: its size, its branch pair, and its checks' summary with
 * the mark of their worst state: failed, then still running, then passed.
 */
function ChangeBlockView({ block }: { readonly block: ChangeBlock }): JSX.Element {
  const { checks } = block;
  return (
    <div className="b-change">
      <span className="b-change-files">
        <DiffIcon size={14} />
        {formatCount(block.files, "file")}
      </span>
      <span className="plus">+{block.additions}</span>
      <span className="minus">−{block.deletions}</span>
      {block.commits !== undefined && <span>{formatCount(block.commits, "commit")}</span>}
      <span className="b-change-ref">
        <BranchIcon size={14} />
        <span className="mono">{block.from}</span>
        <ArrowIcon size={12} />
        <span className="mono">{block.to}</span>
      </span>
      {checks !== undefined && (
        <span className="b-change-checks">
          <Mark state={checks.failed > 0 ? "failed" : checks.pending > 0 ? "working" : "done"} />
          {[
            `${formatCount(checks.passed, "check")} passed`,
            ...(checks.failed > 0 ? [`${String(checks.failed)} failed`] : []),
            ...(checks.pending > 0 ? [`${String(checks.pending)} pending`] : []),
          ].join(" · ")}
        </span>
      )}
    </div>
  );
}

/**
 * Renders the failed and pending checks, one row each with its log under it
 * when it has one, then the passed count and "and N more" for the rows the
 * producer left out.
 */
function ChecksBlockView({ block }: { readonly block: ChecksBlock }): JSX.Element {
  const more = [
    ...(block.passed > 0 ? [`${String(block.passed)} passed`] : []),
    ...(block.omitted > 0 ? [`and ${String(block.omitted)} more`] : []),
  ].join(" · ");
  return (
    <div>
      {block.rows.length > 0 && (
        <ul className="b-checks">
          {block.rows.map((row, index) => (
            <li
              // Two checks can share a name, and the rows never change order.
              key={index}
              className={row.state === "failed" ? "b-check b-check--failed" : "b-check"}
            >
              <span className={row.state === "failed" ? "dot dot--fail" : "dot"} />
              <span className="mono">{row.name}</span>
              {row.url === undefined ? (
                <span>{row.state === "failed" ? "Failed" : "Pending"}</span>
              ) : (
                <a href={row.url} target="_blank" rel="noreferrer">
                  {row.state === "failed" ? "Failed" : "Pending"}
                </a>
              )}
              {row.log !== undefined && <pre className="b-log mono">{row.log}</pre>}
            </li>
          ))}
        </ul>
      )}
      {more !== "" && <p className="b-checks-more">{more}</p>}
    </div>
  );
}

/** Renders the Task that a proposal's Accept creates: its title and description. */
function TaskPreview({ task }: { readonly task: TaskCreateInput }): JSX.Element {
  return (
    <div className="b-work">
      <TasksIcon size={16} />
      <span className="b-work-text">
        <span className="b-work-label">Accept creates this Task</span>
        <b>{task.title}</b>
        {task.description !== "" && <span>{task.description}</span>}
      </span>
    </div>
  );
}
