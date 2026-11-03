import type { JSX, ReactNode } from "react";
import "../settings/settings.css";
import "./machine-page.css";

/**
 * Renders one section of a machine's page: a `section` named by its `h3`
 * `title`. `id` is the target of the header's jump link, and the section stays
 * clear of the floating header when it is scrolled to.
 *
 * The section carries the Settings classes (`set-sec`), so the rows that
 * Settings draws, and the failed-save line under them, look the same here.
 */
export function MachinePageSection({
  id,
  title,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly children: ReactNode;
}): JSX.Element {
  const headingId = `${id}-heading`;
  return (
    <section id={id} className="set-sec machine-page-section" aria-labelledby={headingId}>
      <h3 id={headingId}>{title}</h3>
      {children}
    </section>
  );
}
