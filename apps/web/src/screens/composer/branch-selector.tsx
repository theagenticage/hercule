import { useEffect, useState, type JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  BRANCH_SEARCH_DELAY_MS,
  buildBranchListing,
  buildBranchListRows,
  type BranchField,
  type BranchRow,
  type BranchSearch,
} from "@hercule/client-core";
import type { StartingRevision } from "@hercule/contract";
import { resourceBranchesQuery } from "../../app/queries";
import { MenuFoot, MenuHeader, MenuRow } from "./menu";
import { Phrases } from "./phrases";
import { SelectorShell } from "./selector-shell";

/**
 * Renders the lip's second selector: the observed branch of shared files,
 * or the source a new worktree starts from. Which of the two applies depends on
 * the picked workspace and is decided in `buildBranchField`; this component
 * only renders the field.
 *
 * A field with nothing to choose from is shown as read-only text. Examples: a
 * repo no machine has cloned, or a multi-repo worktree (a base per repo comes
 * after v1). Spec 14 §The composer owns the selector.
 *
 * A repository can have more branches than a menu can hold, so when the field
 * has a repo and a runner to search, the menu lists the newest branches below
 * the fixed rows, with a filter to find the others.
 */
export function BranchSelector({
  field,
  room,
  open,
  onOpenChange,
  onPick,
}: {
  readonly field: BranchField;
  /** How far the menu is nudged left to stay clear of the model pill. */
  readonly room: number;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPick: (startingRevision: StartingRevision) => void;
}): JSX.Element {
  const pick = (startingRevision: StartingRevision): void => {
    onPick(startingRevision);
    onOpenChange(false);
  };
  return (
    <SelectorShell
      // The branch mark is part of the value, not a decoration beside it: the
      // mark and the name together are the value. The mark is centred
      // vertically on the name. Spec 14 §Measurements sets its size.
      label={
        field.glyph ? (
          <span className="flex items-center gap-1 font-mono text-[11px]">
            <BranchMark />
            <span className="truncate">{field.label}</span>
          </span>
        ) : (
          field.label
        )
      }
      locked={field.locked}
      open={open}
      onOpenChange={onOpenChange}
      contentClassName="w-80"
      alignOffset={room}
    >
      <MenuHeader label={field.header} note={field.note} />
      {field.rows.map((row) => (
        <BranchMenuRow key={row.key} row={row} current={row.key === field.value} onPick={pick} />
      ))}
      {field.search === null ? null : (
        <BranchSearchList search={field.search} value={field.value} onPick={pick} />
      )}
      {field.foot === null ? null : (
        <MenuFoot>
          <Phrases parts={field.foot} />
        </MenuFoot>
      )}
    </SelectorShell>
  );
}

/** Renders one starting revision of the menu. */
function BranchMenuRow({
  row,
  current,
  onPick,
}: {
  readonly row: BranchRow;
  readonly current: boolean;
  readonly onPick: (startingRevision: StartingRevision) => void;
}): JSX.Element {
  return (
    <MenuRow
      name={<span className="font-mono">{row.label}</span>}
      note={row.badge}
      dimmed={row.dimmed}
      // The branch name is what the user picks, so it is never truncated;
      // the note beside it is truncated instead.
      clipNote
      current={current}
      onPick={() => {
        onPick(row.startingRevision);
      }}
    />
  );
}

/**
 * Renders the branch filter and the branches of `search`'s repo that match
 * it, and owns the filter's text. The menu's content is drawn only while the
 * menu is open, so the branches are read only then: once when it opens, and
 * again each time the text stays unchanged for `BRANCH_SEARCH_DELAY_MS`.
 */
function BranchSearchList({
  search,
  value,
  onPick,
}: {
  readonly search: BranchSearch;
  /** The key of the picked row, which gets the current dot. */
  readonly value: string;
  readonly onPick: (startingRevision: StartingRevision) => void;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_shell" });
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
  const read = useQuery(resourceBranchesQuery(client, search, searched));
  const listed = buildBranchListRows(buildBranchListing(read.data, read.error), searched);
  return (
    <>
      <input
        aria-label="Filter branches"
        placeholder="Filter branches…"
        autoFocus
        spellCheck={false}
        autoComplete="off"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
        }}
        className="mx-0.5 mt-1.5 mb-1 rounded-[6px] border border-line bg-surface px-[9px] py-[5px] text-meta text-ink outline-none placeholder:text-faint focus:border-live"
      />
      <div className="max-h-[280px] overflow-y-auto">
        {listed.rows.map((row) => (
          <BranchMenuRow key={row.key} row={row} current={row.key === value} onPick={onPick} />
        ))}
        {listed.note === null ? null : (
          <p className="m-0 px-2 py-1.5 text-[11.5px] leading-[1.45] text-faint">{listed.note}</p>
        )}
      </div>
    </>
  );
}

/** The branch icon shown in the lip, drawn as in the prototype: two commits and a fork. */
function BranchMark(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      className="size-[11px] shrink-0"
    >
      <circle cx="6" cy="5" r="2.2" />
      <circle cx="6" cy="19" r="2.2" />
      <circle cx="18" cy="8" r="2.2" />
      <path d="M6 7.2v9.6M18 10.2c0 4-12 2.6-12 6.6" />
    </svg>
  );
}
