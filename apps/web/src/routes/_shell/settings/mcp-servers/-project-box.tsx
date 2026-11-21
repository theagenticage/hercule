import { useState, type JSX } from "react";
import { readErrorMessage, type HerculeClient } from "@hercule/client-core";
import {
  chooseNamedServer,
  describeProjectRefusal,
  type McpServerView,
  type ProjectBox,
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
 * One box of the Projects card: a checkbox that names or un-names the page's
 * server in one list, a project's or the default list. The box owns its
 * write, so each list has at most one write in flight: its checkbox ignores
 * clicks until the write is done and the list is read again.
 *
 * A list holds one server of a name. Ticking a box whose list already names
 * another server of the page's name writes nothing: the box shows the
 * refusal with two buttons, one that swaps the servers in a single write and
 * one that keeps the list as it is. A write that the controller refuses shows
 * its message under the box.
 *
 * Every write is computed from the list as the cache holds it when the click
 * happens, so a list that changed since the box was drawn is never
 * overwritten with an older one.
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
  // Whether the user ticked the box while its list names another server of this name.
  const [refused, setRefused] = useState(false);
  const refusal = refused ? describeProjectRefusal(box, view) : null;
  const name = target.kind === "project" ? target.project.name : "Threads without a project";

  const nameServer = (serverId: string | null): void => {
    write.mutate((current) => chooseNamedServer(current, views, view.server.name, serverId));
  };

  return (
    <li className="flex flex-col gap-1 border-t border-line-soft py-1.5 first:border-t-0">
      <div className="flex items-center gap-2.5 text-row">
        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
          <ChoiceInput
            type="checkbox"
            aria-disabled={write.isPending}
            checked={box.ticked}
            onChange={(event) => {
              if (write.isPending) return;
              if (!event.target.checked) {
                setRefused(false);
                nameServer(null);
              } else if (box.takenBy !== null) setRefused(true);
              else nameServer(view.server.id);
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
              aria-disabled={write.isPending}
              onClick={() => {
                if (write.isPending) return;
                setRefused(false);
                nameServer(view.server.id);
              }}
            >
              <Parts parts={refusal.use} />
            </Button>
            <Button
              onClick={() => {
                setRefused(false);
              }}
            >
              <Parts parts={refusal.keep} />
            </Button>
          </div>
        </div>
      )}
      {write.error === null ? null : (
        <p className="pl-6 text-fine text-fail" role="alert">
          {readErrorMessage(write.error)}
        </p>
      )}
    </li>
  );
}
