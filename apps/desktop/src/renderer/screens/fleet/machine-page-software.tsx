import type { JSX } from "react";
import type { MachineAccountRow, MachineHarnessRow } from "@hercule/client-core/machine-page";
import { HarnessLogo } from "../thread/harness-logo";
import { MachinePageSection } from "./machine-page-section";
import "./machine-page.css";

/**
 * Renders the Software section of a machine's page: one row per harness with
 * its version and what the version means for this Hercule, then one row per
 * account that signs in on each machine, with who is signed in here.
 *
 * - An offline machine shows the versions it last reported in the muted
 *   colour (`isOffline`).
 * - An account that is not signed in has Sign in when its row allows it.
 *   Pressing it calls `onSignIn` with the account's id.
 * - Nothing is installed or updated from here.
 * - The accounts part is left out when no account signs in on each machine.
 */
export function MachinePageSoftware({
  id,
  harnesses,
  accounts,
  isOffline,
  onSignIn,
}: {
  readonly id: string;
  readonly harnesses: readonly MachineHarnessRow[];
  readonly accounts: readonly MachineAccountRow[];
  readonly isOffline: boolean;
  readonly onSignIn: (providerAccountId: string) => void;
}): JSX.Element {
  return (
    <MachinePageSection id={id} title="Software">
      <h4 className="machine-page-sw-heading">Harnesses</h4>
      <ul className="machine-page-sw" aria-label="Harnesses">
        {harnesses.map((row) => (
          <li key={row.harnessId} className="machine-page-sw-row">
            <span className="machine-page-sw-name">
              <HarnessLogo harnessId={row.harnessId} size={13} />
              {row.name}
            </span>
            <span
              className={
                row.isInstalled
                  ? isOffline
                    ? "machine-page-sw-version is-muted"
                    : "machine-page-sw-version"
                  : "machine-page-sw-version is-faint"
              }
            >
              {row.versionText}
            </span>
            <span
              className={
                row.note === null
                  ? "machine-page-sw-note"
                  : `machine-page-sw-note is-${row.note.tone}`
              }
            >
              {row.note?.text}
            </span>
          </li>
        ))}
      </ul>
      {accounts.length === 0 ? null : (
        <>
          <h4 className="machine-page-sw-heading">Accounts signed in here</h4>
          <ul className="machine-page-sw" aria-label="Accounts signed in here">
            {accounts.map((row) => (
              <li key={row.providerAccountId} className="machine-page-sw-row">
                <span className="machine-page-sw-name">
                  <HarnessLogo harnessId={row.harnessId} size={13} />
                  {row.name}
                </span>
                <span className="machine-page-sw-version is-faint">{row.harnessName}</span>
                <span className={`machine-page-sw-note is-${row.tone}`}>{row.text}</span>
                <span className="machine-page-sw-action">
                  {row.canSignIn && (
                    <button
                      type="button"
                      className="btn btn--sm"
                      aria-label={`Sign in to ${row.name}`}
                      onClick={() => onSignIn(row.providerAccountId)}
                    >
                      Sign in
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <p className="machine-page-sw-footnote">
            Accounts with a key or a token work on every machine and need no sign-in here.
          </p>
        </>
      )}
    </MachinePageSection>
  );
}
