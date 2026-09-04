import type { ComponentProps, JSX } from "react";
import { cn } from "./cn";

/**
 * One choice out of a closed list, as the platform's own control.
 *
 * The native element carries typeahead, keyboard handling and a list the
 * browser can scroll at any length - a timezone list is four hundred entries -
 * and it renders nothing into the document that the served content policy has
 * to allow. It wears the same border, ground and focus treatment as `Input`,
 * with the platform's own arrow suppressed for the one drawn here.
 */
export function Select({ className, children, ...props }: ComponentProps<"select">): JSX.Element {
  return (
    <div className="relative w-full">
      <select
        className={cn(
          "w-full cursor-pointer appearance-none rounded-control border border-line bg-raised",
          "py-1.5 pr-8 pl-2.5 text-body text-ink",
          "focus-visible:border-live focus-visible:outline-none",
          "disabled:cursor-default disabled:opacity-50",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <svg
        viewBox="0 0 12 12"
        width={12}
        height={12}
        fill="none"
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-faint"
      >
        <path
          d="m3.2 4.8 2.8 2.8 2.8-2.8"
          stroke="currentColor"
          strokeWidth={1.15}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
