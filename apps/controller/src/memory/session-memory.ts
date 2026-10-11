/**
 * The memory an assistant's session starts with: `core` in full and the
 * index of its topics, rendered as the last part of the system prompt (spec
 * 12 section 6.3). Topic bodies are not included; the session reads them on
 * demand.
 */
import { MEMORY_CORE, MEMORY_TOPIC_COUNT_CAP, type MemoryEntry } from "@hercule/contract";

/**
 * Renders the memory section of an assistant session's system prompt from
 * the body of `core` and the index of the assistant's memory, as
 * `memoryRepository.list` returns it. The `core` entry in the index is
 * skipped, because its body is rendered in full above the topics.
 *
 * Both sections are always present, with a line saying when one is empty, so
 * the assistant learns that it has memory and how to use it before it has
 * written any.
 */
export const renderSessionMemory = (core: string, index: ReadonlyArray<MemoryEntry>): string => {
  const topics = index.filter((entry) => entry.name !== MEMORY_CORE);
  const coreSection =
    core.trim() === ""
      ? "Your core memory is empty. Write what every one of your sessions should know with `hercule memory write me core`."
      : core;
  const topicLines =
    topics.length === 0
      ? [
          `You have no topics yet (0 of ${String(MEMORY_TOPIC_COUNT_CAP)}). Create one with \`hercule memory write me <name> --gist "<one line>"\`.`,
        ]
      : [
          ...topics.map((topic) =>
            topic.gist === ""
              ? `- ${topic.name} (${String(topic.size)} chars)`
              : `- ${topic.name} (${String(topic.size)} chars): ${topic.gist}`,
          ),
          "",
          `${String(topics.length)} of ${String(MEMORY_TOPIC_COUNT_CAP)} topics. Read one in full with \`hercule memory read me <name>\`.`,
        ];
  return ["## Memory (core)", "", coreSection, "", "## Memory topics", "", ...topicLines].join(
    "\n",
  );
};
