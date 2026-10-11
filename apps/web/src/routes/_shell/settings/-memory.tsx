import { useState, type JSX } from "react";
import { useIsMutating, useQuery } from "@tanstack/react-query";
import {
  describeTopicCount,
  formatMemorySize,
  listMemoryTopics,
  readErrorMessage,
  replaceDocumentEdit,
  type HerculeClient,
  type MemoryEdit,
  type MemoryEdits,
} from "@hercule/client-core";
import { MEMORY_CORE } from "@hercule/contract";
import { Button, Group, LaneLabel, ListRow } from "@hercule/ui";
import { memoryIndexQuery } from "../../../app/queries";
import { ASSISTANT_MUTATION_KEY } from "./-assistant-form";
import { MemoryDocumentCard } from "./-memory-document";
import { NewTopicCard } from "./-new-topic";

/** Replaces the unsaved memory edits with what `update` returns for the current ones. */
export type ChangeMemoryEdits = (update: (current: MemoryEdits) => MemoryEdits) => void;

const EMPTY_TOPIC = { name: "", gist: "", body: "" };

/** Which editor is open under the topic list: a stored topic's, the new topic's, or none. */
type OpenEditor = { readonly _tag: "topic"; readonly name: string } | { readonly _tag: "new" };

/**
 * Renders one assistant's memory: the core note, the list of topics, and the
 * editor of the open topic or of a new one.
 *
 * - The unsaved edits belong to the Assistants screen. Edits to a topic, and
 *   the new topic's draft, are kept while another editor is open, so opening
 *   one never loses another's.
 * - Pressing an open topic's row closes its editor; its edits stay.
 * - The memory loads after the assistant's form, so it shows its own loading
 *   and error states instead of holding up the screen.
 */
export function AssistantMemory({
  client,
  assistantId,
  edits,
  onEditsChange,
}: {
  readonly client: HerculeClient;
  readonly assistantId: string;
  readonly edits: MemoryEdits;
  readonly onEditsChange: ChangeMemoryEdits;
}): JSX.Element {
  const index = useQuery(memoryIndexQuery(client, assistantId));
  const [open, setOpen] = useState<OpenEditor | null>(null);
  const openTopic = open?._tag === "topic" ? open.name : null;
  const busy = useIsMutating({ mutationKey: ASSISTANT_MUTATION_KEY }) > 0;

  const changeDocumentEdit =
    (name: string) =>
    (update: (current: MemoryEdit) => MemoryEdit): void => {
      onEditsChange((current) =>
        replaceDocumentEdit(current, name, update(current.documents[name] ?? {})),
      );
    };

  const entries = index.data ?? [];
  const topics = listMemoryTopics(entries);

  return (
    <section className="flex flex-col gap-7">
      <MemoryDocumentCard
        client={client}
        assistantId={assistantId}
        name={MEMORY_CORE}
        edit={edits.documents[MEMORY_CORE] ?? {}}
        onEditChange={changeDocumentEdit(MEMORY_CORE)}
        // `core` cannot be deleted, so its card offers no delete.
        onDeleted={() => undefined}
      />

      <div className="flex flex-col gap-3">
        <div>
          <LaneLabel>Memory topics</LaneLabel>
          <Group>
            {index.data === undefined ? (
              index.error === null ? (
                <p className="px-2.5 py-2 text-row text-muted">Loading…</p>
              ) : (
                <p className="px-2.5 py-2 text-fine text-fail" role="alert">
                  {readErrorMessage(index.error)}
                </p>
              )
            ) : topics.length === 0 ? (
              <p className="px-2.5 py-2 text-row text-muted">No topics yet.</p>
            ) : (
              <ul className="flex flex-col">
                {topics.map((topic) => (
                  <li key={topic.name}>
                    <ListRow
                      selected={topic.name === openTopic}
                      aria-expanded={topic.name === openTopic}
                      onClick={() => {
                        setOpen(
                          topic.name === openTopic ? null : { _tag: "topic", name: topic.name },
                        );
                      }}
                    >
                      {/* The name keeps at most half the row, so a long name
                          still leaves room for the gist. */}
                      <span className="max-w-1/2 shrink-0 truncate font-emph text-ink">
                        {topic.name}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-muted" title={topic.gist}>
                        {topic.gist}
                      </span>
                      <span className="shrink-0 font-mono text-fine tabular-nums text-faint">
                        {formatMemorySize(topic.size)}
                      </span>
                    </ListRow>
                  </li>
                ))}
              </ul>
            )}
          </Group>
          {index.data === undefined ? null : (
            <p className="mt-2 text-fine text-faint">{describeTopicCount(topics.length)}</p>
          )}
        </div>
        {index.data === undefined ? null : (
          <div>
            <Button
              variant="form"
              disabled={busy || open?._tag === "new"}
              onClick={() => {
                setOpen({ _tag: "new" });
                onEditsChange((current) => ({
                  ...current,
                  newTopic: current.newTopic ?? EMPTY_TOPIC,
                }));
              }}
            >
              New topic
            </Button>
          </div>
        )}
      </div>

      {open?._tag === "new" && edits.newTopic !== null ? (
        <NewTopicCard
          client={client}
          assistantId={assistantId}
          entries={entries}
          draft={edits.newTopic}
          onDraftChange={(draft) => {
            onEditsChange((current) => ({ ...current, newTopic: draft }));
          }}
          onCancel={() => {
            onEditsChange((current) => ({ ...current, newTopic: null }));
            setOpen(null);
          }}
          onSaved={(name) => {
            onEditsChange((current) => ({ ...current, newTopic: null }));
            setOpen({ _tag: "topic", name });
          }}
        />
      ) : openTopic === null ? null : (
        <MemoryDocumentCard
          // Keyed by the topic, so one topic's delete question and save
          // state never show on another.
          key={openTopic}
          client={client}
          assistantId={assistantId}
          name={openTopic}
          edit={edits.documents[openTopic] ?? {}}
          onEditChange={changeDocumentEdit(openTopic)}
          onDeleted={() => {
            onEditsChange((current) => replaceDocumentEdit(current, openTopic, {}));
            setOpen(null);
          }}
        />
      )}
    </section>
  );
}
