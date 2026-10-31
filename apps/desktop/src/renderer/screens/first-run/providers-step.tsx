/**
 * The first run's providers step. Presentational: the rows, each with its
 * own sign-in, come in as `children`.
 */
import type { JSX, ReactNode } from "react";
import { PlusIcon } from "../../icons/plus";
import { MarkedRows } from "../step";
import { StepKicker } from "./first-run-frame";

/**
 * Renders the providers step: `heading`, `subheading`, the account rows in
 * `children` when `listsAccounts`, then Add an account, then Continue and Do
 * this later. Add an account calls `onAddAccount`; with `null` it is left
 * out, as while the step waits for the runner. Continue waits for an account
 * to be `ready`; once one is, the step can no longer be put off, so Do this
 * later goes away.
 */
export function ProvidersStep({
  heading,
  subheading,
  ready,
  listsAccounts,
  children,
  onAddAccount,
  onContinue,
  onPutOff,
}: {
  readonly heading: string;
  readonly subheading: string;
  readonly ready: boolean;
  readonly listsAccounts: boolean;
  readonly children: ReactNode;
  readonly onAddAccount: (() => void) | null;
  readonly onContinue: () => void;
  readonly onPutOff: () => void;
}): JSX.Element {
  return (
    <>
      <StepKicker step="providers" />
      <h1 className="st-h">{heading}</h1>
      <p className="st-sub">{subheading}</p>
      {listsAccounts ? <MarkedRows>{children}</MarkedRows> : null}
      {onAddAccount === null ? null : (
        <div className={listsAccounts ? "st-add" : "st-add st-add--first"}>
          <button
            type="button"
            className={listsAccounts ? "btn" : "btn btn--accent"}
            onClick={onAddAccount}
          >
            <PlusIcon size={14} />
            Add an account
          </button>
        </div>
      )}
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
          <button type="button" className="btn btn--quiet" onClick={onPutOff}>
            Do this later
          </button>
        )}
      </div>
    </>
  );
}
