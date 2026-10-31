import type { JSX } from "react";
import { cn } from "../primitives/cn";
import { CLAUDE_MARK, OPENAI_MARK } from "../logos/marks";

/**
 * The SVG path of each provider's monochrome mark, by provider id. The marks
 * ship with the app (`../logos`, from lobehub's MIT-licensed set) and are never
 * fetched at runtime. `ProviderLogo` draws them in the current colour, on model
 * rows, account rows and the composer's pill.
 *
 * pi has no mark of its own, so `ProviderLogo` draws it as the character π.
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
