import type { JSX } from "react";
import type { MachineAccountRow, MachineHarnessRow } from "@hercule/client-core/machine-page";
import type { MachineTools } from "@hercule/client-core/software";
import { HarnessLogo } from "../thread/harness-logo";
import { MachinePageSection } from "./machine-page-section";
import "./machine-page.css";

/**
 * Renders the Software section of a machine's page: one row per harness with
 * its version and what the version means for this Hercule, then one row per
 * account that signs in on each machine, with who is signed in here, then the
 * tools found on the machine with their versions.
 *
 * - A machine that is away shows the versions it last reported in the muted
 *   colour (`isAway`).
 * - An account that is not signed in has Sign in when its row allows it.
 *   Pressing it calls `onSignIn` with the account's id.
 * - Nothing is installed or updated from here.
 * - The accounts part is left out when no account signs in on each machine.
 * - The tools part lists each tool with its version, a long version cut with
 *   an ellipsis and whole in its tooltip, then one faint line naming the tools
 *   that are not installed. It is left out when the machine has not reported
 *   its tools and there is nothing to name.
 */
export function MachinePageSoftware({
  id,
  harnesses,
  accounts,
  tools,
  isAway,
  onSignIn,
}: {
  readonly id: string;
  readonly harnesses: readonly MachineHarnessRow[];
  readonly accounts: readonly MachineAccountRow[];
  readonly tools: MachineTools;
  readonly isAway: boolean;
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
                  ? isAway
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
      {tools.tools.length === 0 && tools.notInstalledText === null ? null : (
        <>
          <h4 className="machine-page-sw-heading">Tools</h4>
          {tools.tools.length === 0 ? null : (
            <ul className="machine-page-sw machine-page-sw--tools" aria-label="Tools">
              {tools.tools.map((tool) => (
                <li key={tool.name} className="machine-page-sw-row">
                  <span className="machine-page-sw-name">{tool.name}</span>
                  <span
                    className={
                      isAway
                        ? "machine-page-sw-version is-tool is-muted"
                        : "machine-page-sw-version is-tool"
                    }
                    title={tool.version}
                  >
                    {tool.version}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {tools.notInstalledText === null ? null : (
            <p className="machine-page-sw-footnote">{tools.notInstalledText}</p>
          )}
        </>
      )}
    </MachinePageSection>
  );
}
