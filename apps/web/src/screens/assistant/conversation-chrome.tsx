import type { JSX } from "react";
import type { AssistantPresence } from "@hercule/client-core";
import { cn } from "@hercule/ui";
import { HeaderRow } from "../header-row";
import { PresenceDot } from "./presence-dot";

/** The hue of the presence word: the dot's hue, with muted text for asleep. */
const WORD_CLASSES: Readonly<Record<AssistantPresence, string>> = {
  working: "text-live",
  idle: "text-live",
  asleep: "text-muted",
  unavailable: "text-fail",
};

/**
 * The conversation screen's header row: the `Assistants /` crumb, the
 * assistant's name, and its presence word. It is the thread's header row, so
 * moving between a conversation and a session view does not shift the page.
 * An assistant with no session yet has no presence, so the name stands alone.
 *
 * The crumb is plain text: there is no list of assistants to go back to yet.
 */
export function ConversationChrome({
  name,
  presence,
}: {
  readonly name: string;
  readonly presence: AssistantPresence | null;
}): JSX.Element {
  return (
    <HeaderRow
      crumb="Assistants"
      title={
        <>
          <span title={name} className="min-w-0 truncate">
            {name}
          </span>
          {presence === null ? null : (
            <>
              {" "}
              <span
                className={cn(
                  "flex shrink-0 items-center gap-1.5 text-meta font-normal tracking-normal",
                  WORD_CLASSES[presence],
                )}
              >
                <PresenceDot presence={presence} />
                {presence}
              </span>
            </>
          )}
        </>
      }
    />
  );
}
