import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { readErrorMessage, type HerculeClient } from "@hercule/client-core";
import {
  buildEntitySearch,
  isPastedLink,
  type AddSource,
  type SearchState,
} from "@hercule/client-core/work";
import type { EntitySearchQuery, EntitySearchReply } from "@hercule/contract";
import { entitySearchQuery } from "../../app/queries";

/** How long typing must stop before a search is sent, in milliseconds. */
const TYPING_PAUSE_MS = 180;

/** What `useEntitySearch` returns. */
export interface EntitySearch {
  /** The words in the search field. */
  readonly text: string;
  /** The words of the search last sent, trimmed, or an empty string when none was. */
  readonly searchedText: string;
  /** The answer to the search last sent, once it comes. */
  readonly reply: EntitySearchReply | undefined;
  /** Where the search last sent stands, for `decideAddList`. */
  readonly state: SearchState;
  /** True when the words sent are a pasted link. */
  readonly isLink: boolean;
  /** Records what the field holds now. An empty field drops the search at once. */
  readonly type: (text: string) => void;
  /** Empties the field and drops the search. */
  readonly clear: () => void;
  /** Sends the words in the field to `source`, narrowed to `scopeRef`, without waiting for a pause. */
  readonly searchIn: (source: string, scopeRef: string) => void;
  /**
   * Sends the words in the field when the list on screen is for older words,
   * and returns true. Returns false when the list is already for them. Return
   * calls it first, so a key press before the typing pause never acts on a
   * stale list.
   */
  readonly searchTypedWords: () => boolean;
}

/**
 * Holds the search of things at a source (`externalEntity.search`) that Work's
 * Add sheet and the open card's "Link something" both draw: the field's words,
 * the search sent for them, and its answer.
 *
 * - Typing waits for a pause of 180ms before it searches. Clearing the field
 *   does not wait. The answer of an older search is never shown once a newer
 *   one was sent.
 * - A pasted link names its own source. When the answer comes from a source
 *   other than `tab` that is one of `sources`, `onSourceMoved` is called with
 *   it during the render that first shows the answer. The caller sets its
 *   own tab state there.
 * - Offline, no search is sent and the state stays idle.
 *
 * `tab` and `scopeRef` say where the field's words go. The caller owns them,
 * because each page picks the tab and the narrowing its own way.
 */
export const useEntitySearch = ({
  client,
  sources,
  tab,
  scopeRef,
  isOffline,
  onSourceMoved,
}: {
  readonly client: HerculeClient;
  readonly sources: readonly AddSource[];
  readonly tab: string;
  readonly scopeRef: string;
  readonly isOffline: boolean;
  readonly onSourceMoved: (source: string) => void;
}): EntitySearch => {
  const [text, setText] = useState("");
  // It keeps the source the words were sent to, so a link that moves the tab does not ask again.
  const [search, setSearch] = useState<EntitySearchQuery | null>(null);
  const searchedText = search?.text ?? "";

  // A search waits for typing to stop.
  useEffect(() => {
    if (text.trim() === searchedText) return;
    const timer = setTimeout(() => {
      setSearch(buildEntitySearch(text, tab, scopeRef));
    }, TYPING_PAUSE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [text, searchedText, tab, scopeRef]);

  const read = useQuery({
    ...entitySearchQuery(client, search ?? undefined),
    enabled: search !== null && !isOffline,
  });
  const reply = read.data;

  const [lastReply, setLastReply] = useState<EntitySearchReply | undefined>(undefined);
  if (reply !== undefined && reply !== lastReply) {
    setLastReply(reply);
    if (reply.source !== tab && sources.some((source) => source.id === reply.source)) {
      onSourceMoved(reply.source);
    }
  }

  const state: SearchState =
    search === null || isOffline
      ? { status: "idle" }
      : reply !== undefined
        ? { status: "answered", reply }
        : read.error !== null
          ? { status: "failed", reason: readErrorMessage(read.error) }
          : { status: "pending" };

  return {
    text,
    searchedText,
    reply,
    state,
    isLink: search !== null && isPastedLink(search.text),
    type: (words) => {
      setText(words);
      if (words.trim() === "") setSearch(null);
    },
    clear: () => {
      setText("");
      setSearch(null);
    },
    searchIn: (source, scope) => {
      setSearch(buildEntitySearch(text, source, scope));
    },
    searchTypedWords: () => {
      if (text.trim() === searchedText) return false;
      setSearch(buildEntitySearch(text, tab, scopeRef));
      return true;
    },
  };
};
