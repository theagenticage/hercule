import { useEffect, useState, type JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  BRANCH_SEARCH_DELAY_MS,
  buildBranchListing,
  buildBranchListRows,
  type BranchField,
  type BranchSearch,
} from "@hercule/client-core";
import type { StartingRevision } from "@hercule/contract";
import { resourceBranchesQuery } from "../../app/queries";
import { BranchMenuContent } from "./lip-menus";

/**
 * Renders the starting revision menu of a Draft Thread's lip, and reads the
 * branches it lists when the field has a repo and runner to search.
 */
export function BranchMenu({
  field,
  onPick,
}: {
  readonly field: BranchField;
  readonly onPick: (revision: StartingRevision) => void;
}): JSX.Element {
  return field.search === null ? (
    <BranchMenuContent field={field} search={null} onPick={onPick} />
  ) : (
    <SearchedBranchMenu field={field} search={field.search} onPick={onPick} />
  );
}

/**
 * Renders the menu with its branch filter, and owns the filter's text. The
 * menu is drawn only while it is open, so the branches are read only then:
 * once when it opens, and again each time the text stays unchanged for
 * `BRANCH_SEARCH_DELAY_MS`.
 */
function SearchedBranchMenu({
  field,
  search,
  onPick,
}: {
  readonly field: BranchField;
  readonly search: BranchSearch;
  readonly onPick: (revision: StartingRevision) => void;
}): JSX.Element {
  const { controller } = useRouteContext({ from: "/_connected" });
  const [text, setText] = useState("");
  const [searched, setSearched] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => {
      // Git refuses spaces in a branch name, so spaces around the text match nothing.
      setSearched(text.trim());
    }, BRANCH_SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [text]);
  const read = useQuery(resourceBranchesQuery(controller.client, search, searched));
  return (
    <BranchMenuContent
      field={field}
      search={{
        text,
        listed: buildBranchListRows(buildBranchListing(read.data, read.error), searched),
        onText: setText,
      }}
      onPick={onPick}
    />
  );
}
