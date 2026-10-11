import { useState, type CSSProperties, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, useRouteContext } from "@tanstack/react-router";
import {
  computeMemoryFill,
  describeTopicCount,
  formatMemorySize,
  formatMemoryUsage,
  listMemoryTopics,
} from "@hercule/client-core";
import { MEMORY_CORE, MEMORY_CORE_CAP, type Assistant } from "@hercule/contract";
import { memoryDocumentQuery, memoryIndexQuery } from "../../../../../app/queries";
import { MemoryIcon } from "../../../../../icons/memory";
import { PlusIcon } from "../../../../../icons/plus";
import { NewTopicDialog } from "./-new-topic-dialog";

/**
 * Renders the Memory column beside an assistant's settings (spec 17
 * §Settings, Assistants), as the book draws it: the core note's size against
 * its cap with a meter, the start of the core note, one row per topic with
 * its size and gist, and how many topics there are against their cap.
 *
 * Edit opens the core note's page, and each topic row opens the topic's
 * page, where the text is edited. New topic, which the book does not draw,
 * asks for a name and creates the topic.
 *
 * The section's loader has read the index and the core note, so nothing here
 * waits. `style` sets the assistant's hue, which the meter and the core
 * note's rule are drawn in.
 */
export function MemoryColumn({
  assistant,
  style,
}: {
  readonly assistant: Assistant;
  readonly style: CSSProperties;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const entries = useSuspenseQuery(memoryIndexQuery(client, assistant.id)).data;
  const core = useSuspenseQuery(memoryDocumentQuery(client, assistant.id, MEMORY_CORE)).data;
  const [creating, setCreating] = useState(false);
  const topics = listMemoryTopics(entries);
  return (
    <aside className="assistant-memory" style={style} aria-label="Memory">
      <section className="memory-side-sec">
        <h3>
          <MemoryIcon size={15} />
          Memory
          <Link
            to="/settings/assistants/$id/memory/$name"
            params={{ id: assistant.id, name: MEMORY_CORE }}
          >
            Edit
          </Link>
        </h3>
        <div className="memory-core-top">
          <b>Core note</b>
          <span>{formatMemoryUsage(core.size, MEMORY_CORE_CAP)}</span>
        </div>
        <div className="meter">
          <i style={{ width: `${String(computeMemoryFill(core.size, MEMORY_CORE_CAP) * 100)}%` }} />
        </div>
        <p className="memory-core-note">
          {core.body === "" ? `${assistant.name}’s core note is empty.` : core.body}
        </p>
        {topics.map((topic) => (
          <Link
            key={topic.name}
            to="/settings/assistants/$id/memory/$name"
            params={{ id: assistant.id, name: topic.name }}
            className="memory-topic"
          >
            <b>{topic.name}</b>
            <small>{formatMemorySize(topic.size)}</small>
            {topic.gist !== "" && <span>{topic.gist}</span>}
          </Link>
        ))}
        <div className="memory-topics-foot">{describeTopicCount(topics.length)}</div>
        <button
          type="button"
          className="btn btn--sm memory-new-topic"
          onClick={() => {
            setCreating(true);
          }}
        >
          <PlusIcon size={13} />
          New topic
        </button>
      </section>
      {creating && (
        <NewTopicDialog
          assistant={assistant}
          entries={entries}
          onClose={() => {
            setCreating(false);
          }}
        />
      )}
    </aside>
  );
}
