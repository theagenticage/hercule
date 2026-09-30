import type { JSX, ReactNode } from "react";
import type { ComposerBlocked, DraftSubject, LoginTarget, Phrase } from "@hercule/client-core";
import { cn } from "@hercule/ui";
import { Phrases } from "./phrases";

/** The two identity hues, written out in full so Tailwind generates them (see `ProjectDot`). */
const TONE = {
  hercule: "decoration-project-hercule",
  ops: "decoration-project-ops",
} as const;

/**
 * Renders the heading and sentence a draft thread shows above its composer:
 * what the thread is for, and where it will run. When something blocks the
 * thread from starting, the blocker replaces the sentence, together with the
 * action that clears it. A blocker never gets a screen of its own, so the user
 * clears it without leaving the draft. Spec 14 §The composer owns the rule.
 */
export function DraftHero({
  subject,
  lead,
  blocked,
  loginSlot,
}: {
  /** The project or workspace the thread starts in; null for a draft with neither. */
  readonly subject: DraftSubject | null;
  /** The sentence shown under the heading when nothing blocks the draft. */
  readonly lead: readonly Phrase[];
  readonly blocked: ComposerBlocked | null;
  readonly loginSlot: (login: LoginTarget, className: string) => ReactNode;
}): JSX.Element {
  return (
    <div className="my-auto pt-1 pb-[42px] text-center">
      <h2 className="mb-1.5 text-[22px] font-emph text-ink">
        {subject === null ? (
          "What should the agent do?"
        ) : (
          <>
            What should the agent do in{" "}
            <span
              className={cn(
                "underline decoration-2 underline-offset-[5px]",
                subject.tone === null ? "decoration-line" : TONE[subject.tone],
              )}
            >
              {subject.label}
            </span>
            ?
          </>
        )}
      </h2>
      <p className="text-row text-muted">
        {blocked === null ? (
          <Phrases parts={lead} />
        ) : (
          <>
            <span className="font-emph text-attn">Can&apos;t start yet.</span> {blocked.reason}.{" "}
            {blocked.login === null ? null : loginSlot(blocked.login, HERO_LOGIN)}
          </>
        )}
      </p>
    </div>
  );
}

/** Classes for the login action that clears a blocker, styled as a link inside the sentence. */
const HERO_LOGIN =
  "p-0 text-row leading-normal text-ink underline decoration-line underline-offset-[3px] enabled:hover:bg-transparent";
