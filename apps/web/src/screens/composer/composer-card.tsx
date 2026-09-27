import type { JSX, ReactNode } from "react";

/**
 * The card at the bottom of a thread or an assistant's conversation: the
 * thread's composer and the conversation's composer. Its first child is the
 * text line and its second the row of controls; with the same padding, the
 * two cards have the same height and their text sits on the same baseline.
 *
 * The card is stacked above what docks to it (the lip below the thread's
 * composer, a permission request above it), so they tuck under its edge and
 * its radius, border and shadow never change (spec 14 §Measurements, amended
 * 2026-09-14).
 */
export function ComposerCard({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <div className="relative z-[1] flex flex-col gap-2 rounded-[14px] border border-line bg-raised px-3.5 pt-3 pb-2.5 shadow-lift">
      {children}
    </div>
  );
}
