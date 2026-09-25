import type { JSX, ReactNode } from "react";
import { cn } from "@hercule/ui";

/**
 * The content column below a screen's header row: up to 800px wide and
 * centred, as spec 14 §The thread surface sets it. The thread screen, the new
 * thread screen and an assistant's conversation screen all use it.
 */
export function ContentColumn({
  className,
  children,
}: {
  readonly className?: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-1 flex-col px-6 pt-2 pb-16">
      <div className={cn("mx-auto flex w-full max-w-[800px] flex-1 flex-col", className)}>
        {children}
      </div>
    </div>
  );
}
