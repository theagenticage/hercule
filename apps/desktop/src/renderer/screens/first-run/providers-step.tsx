/**
 * The first run's providers step. Presentational: the rows, each with its
 * own login, come in as `children`.
 */
import type { JSX, ReactNode } from "react";
import { MarkedRows } from "../step";
import { StepKicker } from "./first-run-frame";

/**
 * Renders the providers step: `heading`, `subheading`, the provider rows in
 * `children`, then Continue and Do this later. Continue waits for a provider
 * to be `ready`; once one is, the step can no longer be put off, so Do this
 * later goes away.
 */
export function ProvidersStep({
  heading,
  subheading,
  ready,
  children,
  onContinue,
  onLater,
}: {
  readonly heading: string;
  readonly subheading: string;
  readonly ready: boolean;
  readonly children: ReactNode;
  readonly onContinue: () => void;
  readonly onLater: () => void;
}): JSX.Element {
  return (
    <>
      <StepKicker step="providers" />
      <h1 className="st-h">{heading}</h1>
      <p className="st-sub">{subheading}</p>
      <MarkedRows>{children}</MarkedRows>
      <div className="st-actions">
        <button
          type="button"
          className="btn btn--accent btn--lg"
          disabled={!ready}
          onClick={onContinue}
        >
          Continue
        </button>
        {ready ? null : (
          <button type="button" className="btn btn--quiet" onClick={onLater}>
            Do this later
          </button>
        )}
      </div>
    </>
  );
}
