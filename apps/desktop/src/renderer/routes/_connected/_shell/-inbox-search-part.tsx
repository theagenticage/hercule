import { useEffect, useState, type JSX, type Ref } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import type { InboxSearch, InboxSearchContext } from "@hercule/client-core/inbox";
import type { InboxList } from "@hercule/contract";
import { inboxCountQuery, inboxValuesQuery, pluginsQuery } from "../../../app/queries";
import { InboxSearchField, type InboxSearchHandle } from "../../../screens/inbox/inbox-search";

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
  readonly resultsText: string;
  readonly onChange: (search: InboxSearch) => void;
  readonly onWiden: () => void;
  readonly onLeaveToResults: () => void;
  readonly onLeave: () => void;
  readonly ref: Ref<InboxSearchHandle>;
}): JSX.Element {
  const counts = useSuspenseQuery(inboxCountQuery(client)).data;
  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  const [typing, setTyping] = useState<{ key: string; typed: string } | null>(null);
  const [asked, setAsked] = useState<{ key: string; typed: string } | null>(null);

  // The read waits for a quiet: `asked` follows `typing` once it has held still.
  useEffect(() => {
    if (typing === null) return;
    const timer = setTimeout(() => {
      setAsked(typing);
    }, QUIET_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [typing]);

  // Once no clause is being typed, an older ask is not read any more.
  const ask = typing === null ? null : asked;
  const values = useQuery(
    inboxValuesQuery(client, ask === null ? undefined : { list, key: ask.key, prefix: ask.typed }),
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
      context={{ fields: counts.fields, suggestedValues: suggested }}
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
