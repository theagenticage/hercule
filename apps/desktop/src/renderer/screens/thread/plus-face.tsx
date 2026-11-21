import type { JSX } from "react";
import type { ThreadServersRow } from "@hercule/client-core/mcp-servers";
import { PlusIcon } from "../../icons/plus";

/**
 * Returns the accessible name of the composer's `+`: "Add", and while one of
 * the thread's MCP servers needs sign-in, that in brackets, such as
 * "Add (1 needs sign-in)". `row` is the thread's servers row.
 */
export const describePlusLabel = (row: ThreadServersRow): string =>
  row.failing ? `Add (${row.words})` : "Add";

/**
 * Renders what is inside the composer's `+`: the plus mark, and a red dot
 * while one of the thread's MCP servers needs sign-in (`row.failing`). The
 * menu's button and the placeholder that stands in for it until its code has
 * loaded both draw it, so they look the same (see `PlusPlaceholder`).
 */
export function PlusFace({ row }: { readonly row: ThreadServersRow }): JSX.Element {
  return (
    <>
      <PlusIcon />
      {row.failing && <i className="dot dot--fail plus-dot" />}
    </>
  );
}
