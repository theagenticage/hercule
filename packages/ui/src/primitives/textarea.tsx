import type { ComponentProps, JSX } from "react";
import { cn } from "./cn";

/** A multi-line text field, styled exactly like `Input`. */
export function Textarea({ className, ...props }: ComponentProps<"textarea">): JSX.Element {
  return (
    <textarea
      className={cn(
        "w-full rounded-control border border-line bg-raised px-2.5 py-1.5 text-body text-ink",
        "min-h-[72px] resize-y leading-relaxed",
        "placeholder:text-faint",
        "focus-visible:border-live focus-visible:outline-none",
        "disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
