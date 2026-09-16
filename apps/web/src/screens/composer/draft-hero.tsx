import type { JSX, ReactNode } from "react";
import type { ComposerBlocked, LoginTarget, Phrase } from "@hydra/client-core";
import { projectTone } from "@hydra/client-core";
import { cn } from "@hydra/ui";
import { Phrases } from "./phrases";

/** What the draft is for, as its heading names it: a project, or a workspace. */
export interface DraftSubject {
  readonly label: string;
  /** The project whose identity hue the name wears; null on a workspace. */
  readonly projectId: string | null;
}

/** The two identity hues, written out so Tailwind emits them (see `ProjectDot`). */
const TONE = {
  hydra: "decoration-project-hydra",
  ops: "decoration-project-ops",
} as const;

/**
 * What a draft thread says above its composer: what it is for, and where it
 * will run. Nothing that stops it from starting is a screen of its own - the
 * blocker takes the sentence's place, with the one action that clears it
 * (spec 14 §The composer).
 */
export function DraftHero({
  subject,
  lead,
  blocked,
  loginSlot,
}: {
  /** What the thread is being started in; null on a draft that stands alone. */
  readonly subject: DraftSubject | null;
  /** The sentence this draft stands under, where nothing blocks it. */
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
                subject.projectId === null
                  ? "decoration-line"
                  : TONE[projectTone(subject.projectId)],
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

/** The one action that clears the blocker, set in the sentence as a link. */
const HERO_LOGIN =
  "p-0 text-row leading-normal text-ink underline decoration-line underline-offset-[3px] enabled:hover:bg-transparent";
