import type { JSX, ReactNode } from "react";
import { Logo } from "@hercule/ui";

/**
 * The frame the three screens outside the app shell share: setup, login, and an
 * onboarding step. The wordmark sits on the page ground and the screen itself is
 * one raised card, which is the depth treatment for what the eye is meant to
 * land on.
 */
export function CenteredScreen({
  title,
  lead,
  children,
}: {
  readonly title: string;
  readonly lead?: string | undefined;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-16">
      <div className="w-full max-w-88">
        <div className="mb-5 pl-0.5 text-lead font-emph text-muted">
          <Logo />
        </div>
        <div className="rounded-card border border-line bg-raised p-6 shadow-card">
          <h1 className="text-title font-emph text-ink">{title}</h1>
          {lead === undefined ? null : <p className="mt-2 text-meta text-muted">{lead}</p>}
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </main>
  );
}
