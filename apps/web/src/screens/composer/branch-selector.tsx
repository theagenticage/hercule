import type { JSX } from "react";
import type { BranchField } from "@hydra/client-core";
import { MenuFoot, MenuHeader, MenuRow } from "./menu";
import { Phrases } from "./phrases";
import { SelectorShell } from "./selector-shell";

/**
 * The lip's second selector: the branch a main workspace switches to, or the
 * ref a fresh worktree starts from (spec 14 §The composer, the Branch
 * selector). Which of the two it is comes off the workspace pick, decided in
 * `branchField`; what is left here is the drawing.
 *
 * A field with nothing to choose between - a repo no machine has cloned, a
 * multi-repo worktree, whose base per repo is post-v1 - is read-only text.
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
  readonly onPick: (branch: string) => void;
}): JSX.Element {
  return (
    <SelectorShell
      // The glyph is part of what the lip reads, not a decoration beside it:
      // the branch mark and the name are the whole value (spec 14
      // §Measurements, the Lip), and the mark sits on the name's own centre.
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
        <MenuRow
          key={row.branch}
          name={<span className="font-mono">{row.branch}</span>}
          note={row.badge}
          dimmed={row.dimmed}
          // A branch name is never cut: what holds it is (R6).
          clipNote
          current={row.branch === field.value}
          onPick={() => {
            onPick(row.branch);
            onOpenChange(false);
          }}
        />
      ))}
      {field.foot === null ? null : (
        <MenuFoot>
          <Phrases parts={field.foot} />
        </MenuFoot>
      )}
    </SelectorShell>
  );
}

/** The branch mark the lip carries, as the prototype draws it: two commits and a fork. */
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
