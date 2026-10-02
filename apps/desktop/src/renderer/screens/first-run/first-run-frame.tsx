/**
 * The first run's frame, as variant B of the Bureau book's first run draws
 * it: the Office room fills the window, the step ladder floats at the top,
 * and the step floats on a glass card at the right. Every part here is
 * presentational.
 */
import type { JSX, ReactNode } from "react";
import { FIRST_RUN_STEPS, type FirstRunRungStatus, type FirstRunStep } from "@hercule/client-core";
import { CheckIcon, PauseIcon } from "../../icons";
import { LogoMark } from "../../logos";
import "../step/step.css";
import "./first-run.css";

/** The ladder's label for each step. */
const RUNG_LABELS: { readonly [Step in FirstRunStep]: string } = {
  account: "Account",
  providers: "Providers",
  github: "GitHub",
  project: "Project",
};

const RUNG_CLASSES: { readonly [Status in FirstRunRungStatus]: string | undefined } = {
  now: "is-now",
  done: "is-done",
  // A step put off is passed like a finished one, so it is drawn the same,
  // with a pause mark in place of the tick.
  "put-off": "is-done",
  next: undefined,
};

/**
 * Renders the first run: `room` behind everything, the ladder of `rungs` at
 * the top when there are rungs, and `children` on the card. With `brand`, the
 * card starts with the app's icon and the wordmark, as the welcome does.
 */
export function FirstRunFrame({
  room,
  rungs,
  brand,
  children,
}: {
  readonly room: ReactNode;
  readonly rungs: readonly { readonly step: FirstRunStep; readonly status: FirstRunRungStatus }[];
  readonly brand: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="fr">
      <div className="fr-stage">{room}</div>
      {rungs.length === 0 ? null : (
        <ol className="fr-ladder" aria-label="Steps">
          {rungs.map(({ step, status }, index) => (
            <li
              key={step}
              className={RUNG_CLASSES[status]}
              aria-current={status === "now" ? "step" : undefined}
            >
              <span className="n">
                {status === "done" ? (
                  <CheckIcon size={12} />
                ) : status === "put-off" ? (
                  <PauseIcon size={12} />
                ) : (
                  index + 1
                )}
              </span>
              {RUNG_LABELS[step]}
            </li>
          ))}
        </ol>
      )}
      <main className="fr-panel">
        {brand ? (
          <div className="fr-brand">
            <span className="app-icon">
              <LogoMark size={48} />
            </span>
            <span className="wordmark">Hercule</span>
          </div>
        ) : null}
        <div className="fr-body">{children}</div>
      </main>
    </div>
  );
}

/** Renders the kicker over a step's heading: "Step 2 of 4". */
export function StepKicker({ step }: { readonly step: FirstRunStep }): JSX.Element {
  const number = FIRST_RUN_STEPS.indexOf(step) + 1;
  return (
    <p className="st-kicker">{`Step ${String(number)} of ${String(FIRST_RUN_STEPS.length)}`}</p>
  );
}
