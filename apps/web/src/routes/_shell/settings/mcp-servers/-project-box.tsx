import type { JSX } from "react";
import { readErrorMessage, type HerculeClient } from "@hercule/client-core";
import {
  decideProjectBoxWrite,
  describeProjectRefusal,
  type McpServerView,
  type ProjectBox,
  type ProjectBoxAction,
  type TextPart,
} from "@hercule/client-core/mcp-servers";
import { Button, ChoiceInput } from "@hercule/ui";
import { useWriteServerList } from "./-write-list";

/** Draws the parts of a sentence, the code spans in mono. */
function Parts({ parts }: { readonly parts: readonly TextPart[] }): JSX.Element {
  return (
    <>
      {parts.map((part, index) =>
        part.code ? (
          <code key={index} className="font-mono">
            {part.text}
          </code>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

/**
 * Why a click on a box was refused: the target's list names `occupant`, a
 * server of the page's name, by the time the click was applied. The write
 * throws it before anything is sent, so it is kept as the target's refusal
 * like any other, and it carries the server of the page it was made for,
 * because another server's page draws the same box.
 */
class OccupantRefused extends Error {
  readonly occupant: McpServerView;
  readonly forServerId: string;

  constructor(occupant: McpServerView, forServerId: string) {
    super(`The list already names ${occupant.server.name}.`);
    this.occupant = occupant;
    this.forServerId = forServerId;
  }
}

/**
 * One box of the Projects card: a checkbox that names or un-names the page's
 * server in one list, a project's or the default list. Each list has at most
 * one write in flight, whichever box or page started it: its checkbox ignores
 * clicks until the write is done and the list is read again.
 *
 * A list holds one server of a name. Ticking a box whose list already names
 * another server of the page's name writes nothing: the box shows the
 * refusal with two buttons, one that swaps the servers in a single write and
 * one that keeps the list as it is. A write that the controller refuses shows
 * its message under the box.
 *
 * Every click is decided by `decideProjectBoxWrite` on the list as the cache
 * holds it when the click is applied, never on the list the box was drawn
 * from. So a list that changed since is never overwritten, and a swap the
 * user confirmed for one occupant is refused, with the new occupant named,
 * when the list names another by then.
 */
export function ProjectBoxRow({
  client,
  view,
  views,
  box,
}: {
  readonly client: HerculeClient;
  /** The server the page is about. */
  readonly view: McpServerView;
  readonly views: readonly McpServerView[];
  readonly box: ProjectBox;
}): JSX.Element {
  const { target } = box;
  const write = useWriteServerList(
    client,
    target.kind === "project" ? { kind: "project", projectId: target.project.id } : target,
  );
  // The target's refusal belongs to this page only when it was made for this page's server.
  const occupantRefused =
    write.refusal instanceof OccupantRefused && write.refusal.forServerId === view.server.id
      ? write.refusal
      : null;
  const failure =
    write.refusal === null || write.refusal instanceof OccupantRefused
      ? null
      : readErrorMessage(write.refusal);
  const refusal =
    occupantRefused === null
      ? null
      : describeProjectRefusal({ ...box, takenBy: occupantRefused.occupant }, view);
  const name = target.kind === "project" ? target.project.name : "Threads without a project";

  const request = (action: ProjectBoxAction): void => {
    write.write((current) => {
      const decision = decideProjectBoxWrite(current, views, view, action);
      if (decision.kind === "refused") throw new OccupantRefused(decision.occupant, view.server.id);
      return decision.mcpServerIds;
    });
  };

  return (
    <li className="flex flex-col gap-1 border-t border-line-soft py-1.5 first:border-t-0">
      <div className="flex items-center gap-2.5 text-row">
        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
          <ChoiceInput
            type="checkbox"
            aria-disabled={write.writing}
            checked={box.ticked}
            onChange={(event) => {
              request(event.target.checked ? "tick" : "untick");
            }}
          />
          <span className="min-w-0 truncate font-emph text-ink">{name}</span>
        </label>
        {box.takenBy === null || refusal !== null ? null : (
          <span className="shrink-0 text-fine text-muted">
            uses <code className="font-mono">{box.takenBy.server.name}</code>
            {box.takenBy.account === undefined ? null : (
              <>
                {" "}
                <code className="font-mono">{box.takenBy.account}</code>
              </>
            )}
          </span>
        )}
      </div>
      {refusal === null ? null : (
        <div className="flex flex-col gap-1.5 pl-6" role="alert">
          <p className="text-fine text-fail">
            <Parts parts={refusal.sentence} />
          </p>
          <div className="flex items-center gap-1.5">
            <Button
              variant="primary"
              aria-disabled={write.writing}
              onClick={() => {
                if (occupantRefused !== null)
                  request({ swapFrom: occupantRefused.occupant.server.id });
              }}
            >
              <Parts parts={refusal.use} />
            </Button>
            <Button onClick={write.clearRefusal}>
              <Parts parts={refusal.keep} />
            </Button>
          </div>
        </div>
      )}
      {failure === null ? null : (
        <p className="pl-6 text-fine text-fail" role="alert">
          {failure}
        </p>
      )}
    </li>
  );
}
