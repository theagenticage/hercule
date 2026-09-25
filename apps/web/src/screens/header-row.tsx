import type { JSX, ReactNode } from "react";

/**
 * The header row a screen draws in place of the shell's top bar: a faint
 * crumb followed by " /", then the screen's title, then the actions on the
 * right. The thread screen and an assistant's conversation screen both draw
 * it, so moving between the two does not shift the page.
 *
 * Spec 14 §The thread surface sets the row at 16px and the emphasis weight.
 * The design language's type scale has no 16px step (lead is 15px, title
 * 18px), so the size stays a pixel value rather than a scale token.
 */
export function HeaderRow({
  crumb,
  title,
  actions,
}: {
  readonly crumb: ReactNode;
  readonly title: ReactNode;
  readonly actions?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2.5 px-6 pt-3 pb-2 text-[16px] font-emph text-ink">
      <span className="shrink-0 font-normal text-faint">{crumb} /</span> {title}
      {actions === undefined ? null : (
        <span className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</span>
      )}
    </div>
  );
}
