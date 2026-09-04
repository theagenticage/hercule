import type { ComponentProps, JSX } from "react";
import { cn } from "./cn";

export function Input({ className, ...props }: ComponentProps<"input">): JSX.Element {
  return (
    <input
      className={cn(
        "w-full rounded-control border border-line bg-raised px-2.5 py-1.5 text-body text-ink",
        "placeholder:text-faint",
        "focus-visible:border-live focus-visible:outline-none",
        "disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
