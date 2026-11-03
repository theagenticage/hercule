import type { JSX, ReactNode } from "react";
import "../settings/settings.css";
import "./machine-page.css";

/**
 * Renders one section of a machine's page: a `section` named by its `h3`
 * `title`. `id` is the target of the header's jump link, and the section stays
 * clear of the floating header when it is scrolled to. `note`, when given, is
 * a quiet line at the far end of the heading. It is not part of the section's
 * name.
 *
 * The section carries the Settings classes (`set-sec`), so the rows that
 * Settings draws, and the failed-save line under them, look the same here.
 *
 * `actions` is a control drawn at the far end of the heading's row, such as a
 * view switch. A section has a `note` or `actions`, not both.
 */
export function MachinePageSection({
  id,
  title,
  note,
  actions,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly note?: string;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}): JSX.Element {
  const headingId = `${id}-heading`;
  return (
    <section id={id} className="set-sec machine-page-section" aria-labelledby={headingId}>
      <header
        className={
          actions === undefined
            ? "machine-page-section-head"
            : "machine-page-section-head machine-page-section-head-with-actions"
        }
      >
        <h3 id={headingId}>{title}</h3>
        {note === undefined ? null : <small>{note}</small>}
        {actions}
      </header>
      {children}
    </section>
  );
}
