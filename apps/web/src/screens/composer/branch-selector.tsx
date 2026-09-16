import type { JSX } from "react";
import type { BranchField } from "@hydra/client-core";
import { MenuFoot, MenuHeader, MenuRow } from "./menu";
import { SelectorShell } from "./selector-shell";

/**
 * The lip's second selector: the branch a shared checkout switches to, or the
 * ref a fresh worktree starts from (spec 14 §The composer, the Branch
 * selector). Which of the two it is comes off the workspace pick, decided in
 * `branchField`; what is left here is the drawing.
 *
 * A field with nothing to choose between - a repo no machine has cloned, a
 * multi-repo worktree, whose base per repo is post-v1 - is read-only text.
 */
export function BranchSelector({
  field,
  open,
  onOpenChange,
  onPick,
}: {
  readonly field: BranchField;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPick: (branch: string) => void;
}): JSX.Element {
  return (
    <SelectorShell
      // The glyph is part of what the lip reads, not a decoration beside it:
      // `⎇ main` is the whole value (spec 14 §Measurements, the Lip).
      label={
        field.glyph ? (
          <span className="inline-flex items-center gap-1 font-mono text-[11px]">
            <span aria-hidden="true">⎇</span>
            {field.label}
          </span>
        ) : (
          field.label
        )
      }
      locked={field.locked}
      open={open}
      onOpenChange={onOpenChange}
      contentClassName="w-80"
    >
      <MenuHeader label={field.header} note={field.note} />
      {field.rows.map((row) => (
        <MenuRow
          key={row.branch}
          name={<span className="font-mono">{row.branch}</span>}
          note={row.badge}
          dimmed={row.dimmed}
          current={row.branch === field.value}
          onPick={() => {
            onPick(row.branch);
            onOpenChange(false);
          }}
        />
      ))}
      {field.foot === null ? null : <MenuFoot>{field.foot}</MenuFoot>}
    </SelectorShell>
  );
}
