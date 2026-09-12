import type { JSX } from "react";
import { cn } from "../primitives/cn";
import { CLAUDE_MARK, OPENAI_MARK } from "../logos/marks";

/**
 * A provider's monochrome mark, drawn in the current colour: on a model row,
 * on an account row and on the composer's pill. The marks are shipped with
 * the app (`../logos`, lobehub's set under MIT), never fetched at runtime.
 *
 * pi has no mark of its own, so it is written the way it is read.
 */
const MARKS: Readonly<Record<string, string>> = {
  "claude-code": CLAUDE_MARK,
  codex: OPENAI_MARK,
};

export function ProviderLogo({
  providerId,
  className,
}: {
  readonly providerId: string;
  readonly className?: string;
}): JSX.Element | null {
  if (providerId === "pi") {
    return (
      <span aria-hidden="true" className={cn("font-mono leading-none", className)}>
        π
      </span>
    );
  }

  const mark = MARKS[providerId];
  if (mark === undefined) return null;

  return (
    <svg
      aria-hidden="true"
      fill="currentColor"
      fillRule="evenodd"
      viewBox="0 0 24 24"
      className={cn("size-[13px] shrink-0", className)}
    >
      <path d={mark} />
    </svg>
  );
}
