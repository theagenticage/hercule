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
  /** The sentence, or nothing at all: an active thread stands under none. */
  readonly lead: string | null;
  readonly blocked: ComposerBlocked | null;
  readonly loginSlot: (login: LoginTarget, className: string) => ReactNode;
}): JSX.Element | null {
  if (lead === null) return null;
  return (
    <div className="my-auto pt-1 pb-[42px] text-center">
      <h2 className="mb-1.5 text-[22px] font-emph text-ink">What should the agent do?</h2>
      <p className="text-row text-muted">
        {blocked === null ? (
          lead
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

/** The one action that clears the blocker, set in the sentence as a link. */
const HERO_LOGIN =
  "p-0 text-row leading-normal text-ink underline decoration-line underline-offset-[3px] enabled:hover:bg-transparent";
