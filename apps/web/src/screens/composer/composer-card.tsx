import type { JSX, ReactNode } from "react";

/**
 * Renders the card at the bottom of a thread or an assistant's conversation:
 * the thread's composer and the conversation's composer. Its first child is
 * the text line and its second the row of controls; with the same padding,
 * the two cards have the same height and their text sits on the same
 * baseline.
 *
 * The card is stacked above what docks to it: the lip below the thread's
 * composer, and a permission request above it. Both tuck under the card's
 * edge, so the card's radius, border and shadow stay the same whether
 * anything is docked or not. Spec 14 §Measurements sets the sizes.
 */
export function ComposerCard({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <div className="relative z-[1] flex flex-col gap-2 rounded-[14px] border border-line bg-raised px-3.5 pt-3 pb-2.5 shadow-lift">
      {children}
    </div>
  );
}
