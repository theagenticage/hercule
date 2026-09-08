import type { JSX, ReactNode } from "react";
import { ListRow } from "@hydra/ui";

/**
 * One row of a composer selector's menu: a label, and a second line that is
 * either an informational detail (a runner's identity, say) or - when the row
 * cannot be picked - the reason, which is what the "dimmed with the reason,
 * never hidden" rule (spec 14 §The composer) means at the row level.
 *
 * `blocking` is the difference between the two ways a row dims: a runner or a
 * model nobody is logged into cannot be picked at all, but a declared-unsupported
 * access mode still can be - the composer honours the choice and runs it at its
 * declared fallback rather than refusing it, so that dimming is informational
 * only and the row stays clickable.
 */
export function MenuRow({
  label,
  secondLine = null,
  selected = false,
  dimmed = null,
  blocking = true,
  onClick,
}: {
  readonly label: ReactNode;
  readonly secondLine?: string | null;
  readonly selected?: boolean;
  readonly dimmed?: string | null;
  readonly blocking?: boolean;
  readonly onClick?: () => void;
}): JSX.Element {
  const line = dimmed ?? secondLine;
  return (
    <ListRow
      selected={selected}
      dimmed={dimmed !== null}
      disabled={dimmed !== null && blocking}
      onClick={onClick}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{label}</span>
        {line === null ? null : <span className="truncate text-fine text-faint">{line}</span>}
      </span>
    </ListRow>
  );
}
