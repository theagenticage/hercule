import type { JSX, ReactNode } from "react";
import type { ComposerBlocked, LoginTarget } from "@hydra/client-core";

/**
 * What a draft thread says above its composer: what it is for, and where it
 * will run. Nothing that stops it from starting is a screen of its own - the
 * blocker takes the sentence's place, with the one action that clears it
 * (spec 14 §The composer).
 */
export function DraftHero({
  lead,
  blocked,
  loginSlot,
}: {
  /** The sentence, or nothing at all: a started thread stands under none. */
  readonly lead: string | null;
  readonly blocked: ComposerBlocked | null;
  readonly loginSlot: (login: LoginTarget) => ReactNode;
}): JSX.Element | null {
  if (lead === null) return null;
  return (
    <div className="my-auto pb-6 text-center">
      <h2 className="mb-1.5 text-[22px] font-emph text-ink">What should the agent do?</h2>
      <div className="flex items-center justify-center gap-2 text-row text-muted">
        {blocked === null ? (
          lead
        ) : (
          <>
            <span>
              <span className="font-emph text-attn">Can&apos;t start yet.</span> {blocked.reason}.
            </span>
            {blocked.login === null ? null : loginSlot(blocked.login)}
          </>
        )}
      </div>
    </div>
  );
}
