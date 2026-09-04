import type { ComponentProps, JSX } from "react";
import { Root } from "@radix-ui/react-label";
import { cn } from "./cn";

export function Label({ className, ...props }: ComponentProps<typeof Root>): JSX.Element {
  return (
    <Root
      className={cn("text-meta text-muted font-emph", "peer-disabled:opacity-50", className)}
      {...props}
    />
  );
}
