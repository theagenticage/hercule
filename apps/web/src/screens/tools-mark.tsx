import type { JSX } from "react";
import { cn } from "@hercule/ui";

/**
 * Draws the mark of an MCP server that no plugin offers, a wrench, in the
 * current text colour on the same 16 by 16 grid as a plugin's mark. Hidden
 * from assistive technology, because the server's name stands beside it.
 */
export function ToolsMark({ className }: { readonly className?: string | undefined }): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("size-[13px] shrink-0", className)}
    >
      <path d="M11.38 2.57L9.11 4.84a.6.6 0 0 0 0 .84l1.21 1.21a.6.6 0 0 0 .84 0l2.27-2.27a3.7 3.7 0 0 1-4.81 4.81l-3.75 3.75a1.45 1.45 0 0 1-2.05-2.05l3.75-3.75a3.7 3.7 0 0 1 4.81-4.81z" />
    </svg>
  );
}
