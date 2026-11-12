import { useState, type JSX, type Ref } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import type { InboxSearch, InboxSearchContext } from "@hercule/client-core/inbox";
import type { InboxList } from "@hercule/contract";
import { inboxOutlineQuery, inboxValuesQuery, pluginsQuery } from "../../../app/queries";
import { useQuietValue } from "../../../app/use-quiet-value";
import { InboxSearchField, type InboxSearchHandle } from "../../../screens/inbox/inbox-search";

/** The source, and the account when there is one, that the clause being typed is tied to, for the field `key`. */
export interface SearchTie {
  readonly key: string;
  readonly source: string;
  readonly connectionId?: string;
}

/** How long typing stops before the field asks for the values of the clause being typed, in milliseconds. */
const QUIET_MS = 150;

/**
 * Renders the Inbox's search field. It owns the read of value suggestions:
 * the field reports the clause being typed, and after a short quiet this
 * asks the controller for that field's values among the things of `list`
 * (before the search narrows them). A newer clause replaces an older read.
 *
 * `scopeTitle` names the list the search is in, and `isScopeEverything` hides
 * the scope token when the list is already Everything.
 */
export function InboxSearchPart({
  client,
  list,
  scopeTitle,
  isScopeEverything,
  search,
  tie,
  resultsText,
  onChange,
  onWiden,
  onLeaveToResults,
  onLeave,
  ref,
}: {
  readonly client: HerculeClient;
  readonly list: InboxList;
  readonly scopeTitle: string;
  readonly isScopeEverything: boolean;
  readonly search: InboxSearch;
  /** Set when the clause being typed belongs to one source and account. Null otherwise. */
  readonly tie: SearchTie | null;
  readonly resultsText: string;
  readonly onChange: (search: InboxSearch) => void;
  readonly onWiden: () => void;
  readonly onLeaveToResults: () => void;
  readonly onLeave: () => void;
  readonly ref: Ref<InboxSearchHandle>;
}): JSX.Element {
  const outline = useSuspenseQuery(inboxOutlineQuery(client)).data;
  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  const [typing, setTyping] = useState<{ key: string; typed: string } | null>(null);
  // The read waits for a quiet: `asked` follows `typing` once it has held still.
  const asked = useQuietValue(typing, QUIET_MS);

  // Once no clause is being typed, an older ask is not read any more.
  const ask = typing === null ? null : asked;
  const values = useQuery(
    inboxValuesQuery(
      client,
      ask === null
        ? undefined
        : {
            list,
            key: ask.key,
            prefix: ask.typed,
            ...(tie?.key === ask.key
              ? {
                  source: tie.source,
                  ...(tie.connectionId === undefined ? {} : { connectionId: tie.connectionId }),
                }
              : {}),
          },
    ),
  );
  const suggested: InboxSearchContext["suggestedValues"] =
    ask === null || values.data === undefined
      ? {}
      : {
          [ask.key]: values.data.values.map((each) => ({ value: each.label, count: each.count })),
        };

  return (
    <InboxSearchField
      ref={ref}
      search={search}
      context={{
        fields: outline.fields,
        suggestedValues: suggested,
        ...(tie === null
          ? {}
          : {
              tie: {
                source: tie.source,
                ...(tie.connectionId === undefined ? {} : { connectionId: tie.connectionId }),
              },
            }),
      }}
      scopeTitle={scopeTitle}
      scopeIsEverything={isScopeEverything}
      plugins={plugins}
      resultsText={resultsText}
      onChange={onChange}
      onOpenClauseChange={(key, typed) => {
        setTyping(key === null ? null : { key, typed });
      }}
      onWiden={onWiden}
      onLeaveToResults={onLeaveToResults}
      onLeave={onLeave}
    />
  );
}
