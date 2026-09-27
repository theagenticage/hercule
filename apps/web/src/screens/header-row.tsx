import type { JSX, ReactNode } from "react";

/**
 * Renders the header row a screen draws in place of the shell's top bar: a
 * faint crumb followed by " /", then the screen's title, then the actions on
 * the right. The thread screen and an assistant's conversation screen both
 * draw it, so moving between the two does not shift the page.
 *
 * The row sits exactly where the top bar puts every other screen's title: the
 * same 32px inset, the same 22px from the top, and the title at the title
 * size. The row is one title line high, so a taller tab or action button
 * beside the title cannot push the title down out of line with other screens.
 *
 * The row stays at the top of the page while the column under it scrolls, so
 * the crumb and the presence word never scroll out of view. Its background is
 * the page's, so the column scrolls out of sight beneath it.
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
    <div className="sticky top-0 z-10 shrink-0 bg-bg px-8 pt-[22px] pb-3">
      <div className="flex h-[1lh] items-center gap-2.5 text-title font-emph tracking-[-0.015em] text-ink">
        {/* The space keeps the crumb and the title apart in the text a screen
            reader or a copy reads; the gap does it on screen. */}
        <span className="shrink-0 font-normal text-faint">{crumb} /</span> {title}
        {actions === undefined ? null : (
          <span className="ml-auto flex shrink-0 items-center gap-1.5 tracking-normal">
            {actions}
          </span>
        )}
      </div>
    </div>
  );
}
