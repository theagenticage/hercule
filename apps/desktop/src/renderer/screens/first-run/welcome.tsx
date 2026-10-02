/**
 * The first run's welcome: what the app found on this Mac, and the way on.
 * Presentational.
 */
import { useRef, type FormEvent, type JSX, type ReactNode } from "react";
import { IntakeIcon } from "../../icons/intake";
import { ServerIcon } from "../../icons/server";
import { ShieldIcon } from "../../icons/shield";
import { WorkspaceIcon } from "../../icons/workspace";
import { Mark } from "../../marks";
import { CopyButton, FormField, Warning } from "../step";

/**
 * The command that installs Hercule, from spec 15's install script. The
 * welcome offers it when there is no binary to start.
 */
const INSTALLER_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/theagenticage/hercule/edge/install.sh | sh";

/**
 * What the welcome found, or what happened when it tried to start Hercule:
 *
 * - `searching`: the app is looking for Hercule on this Mac.
 * - `fresh`: nothing runs here yet; Open the office starts Hercule.
 * - `starting`: Open the office is starting Hercule.
 * - `found`: Hercule runs on this Mac at `address`, not set up yet.
 * - `no-answer`: Hercule started but nothing answered at `address`;
 *   its logs are in `logsDir`.
 * - `start-error`: starting Hercule failed with `line`.
 * - `not-installed`: there is no Hercule on this Mac to start.
 * - `runner`: this Mac is another machine's runner, `running` or stopped.
 */
export type WelcomeState =
  | { readonly kind: "searching" }
  | { readonly kind: "fresh" }
  | { readonly kind: "starting" }
  | { readonly kind: "found"; readonly address: string }
  | { readonly kind: "no-answer"; readonly address: string; readonly logsDir: string }
  | { readonly kind: "start-error"; readonly line: string }
  | { readonly kind: "not-installed" }
  | { readonly kind: "runner"; readonly running: boolean };

/**
 * Renders the welcome in `state`. `onOpenOffice` runs on Open the office and
 * on Try again, `onShowLogs` on Show in Finder, and `onConnectElsewhere` on
 * every way to Hercule on another machine.
 */
export function Welcome({
  state,
  onOpenOffice,
  onShowLogs,
  onConnectElsewhere,
}: {
  readonly state: WelcomeState;
  readonly onOpenOffice: () => void;
  readonly onShowLogs: () => void;
  readonly onConnectElsewhere: () => void;
}): JSX.Element {
  const tryAgain = (
    <div className="st-actions">
      <button type="button" className="btn btn--accent btn--lg" onClick={onOpenOffice}>
        Try again
      </button>
      <button type="button" className="btn btn--quiet" onClick={onConnectElsewhere}>
        It runs on another machine
      </button>
    </div>
  );
  switch (state.kind) {
    case "no-answer":
      return (
        <>
          <h1 className="st-h">Hercule didn’t start</h1>
          <p className="st-sub">
            The app started Hercule in the background, but it never answered. Its logs may say why:
          </p>
          <div className="cmd">
            <span>{state.logsDir}</span>
            <span className="spacer" />
            <button type="button" className="btn btn--sm btn--quiet" onClick={onShowLogs}>
              Show in Finder
            </button>
          </div>
          <p className="reach reach--off">
            <span className="dot-ok" />
            <span>
              Nothing answers at <span className="mono">{state.address}</span>
            </span>
          </p>
          {tryAgain}
        </>
      );
    case "start-error":
      return (
        <>
          <h1 className="st-h">Hercule didn’t start</h1>
          <p className="st-sub">Starting Hercule on this Mac stopped with this error:</p>
          <Warning icon={<ShieldIcon size={14} />}>{state.line}</Warning>
          {tryAgain}
        </>
      );
    case "not-installed":
      return <NotInstalled tryAgain={tryAgain} />;
    case "runner":
      return (
        <>
          <h1 className="st-h">This Mac is a runner</h1>
          <p className="st-sub">
            It runs agents for Hercule on another machine, so Hercule itself doesn’t run here.
            Connect to that machine to open its office.
          </p>
          <p className={state.running ? "reach" : "reach reach--off"}>
            <span className="dot-ok" />
            <span>
              <b>
                {state.running
                  ? "Hercule’s runner is running on this Mac"
                  : "Hercule’s runner is stopped on this Mac"}
              </b>
            </span>
            <span className="spacer" />
            <span>starts at login</span>
          </p>
          <div className="st-actions">
            <button type="button" className="btn btn--accent btn--lg" onClick={onConnectElsewhere}>
              Connect to it
            </button>
          </div>
        </>
      );
    case "searching":
    case "fresh":
    case "starting":
    case "found":
      return (
        <>
          <p className="lead">
            Hand off the work.
            <br />
            Keep the decisions.
          </p>
          <p className="st-sub">
            Hercule gives coding agents desks of their own on this Mac. They work through the night,
            and come to you when a decision is yours.
          </p>
          <ul className="perks">
            <Perk icon={<WorkspaceIcon />} title="A workspace for every thread">
              Each agent works on its own branch. Your checkout stays exactly as you left it.
            </Perk>
            <Perk icon={<IntakeIcon />} title="Work arrives prepared">
              Triage reads what GitHub sends and brings you Proposals, not notifications.
            </Perk>
            <Perk icon={<Mark state="waiting" />} title="You keep the decisions">
              When an agent needs you, it raises its hand and waits.
            </Perk>
          </ul>
          <ReachLine state={state} />
          <div className="st-actions">
            <button
              type="button"
              className="btn btn--accent btn--lg"
              disabled={state.kind === "searching"}
              aria-busy={state.kind === "starting" ? true : undefined}
              aria-disabled={state.kind === "starting" ? true : undefined}
              onClick={onOpenOffice}
            >
              {state.kind === "starting" ? (
                <>
                  <span className="spin" />
                  Starting Hercule…
                </>
              ) : (
                "Open the office"
              )}
            </button>
            <span className="fine">Four steps, about three minutes</span>
          </div>
          <p className="st-note">
            <ServerIcon size={14} />
            <span>
              Hercule already runs on another machine?{" "}
              <button type="button" className="link" onClick={onConnectElsewhere}>
                Connect to it
              </button>
            </span>
          </p>
        </>
      );
  }
}

/** Renders one of the welcome's three perks: `icon` in a sunken square, `title` over `children`. */
function Perk({
  icon,
  title,
  children,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <li>
      <span className="ico">{icon}</span>
      <span>
        <b>{title}</b>
        {children}
      </span>
    </li>
  );
}

/** Renders the line under the perks that says where Hercule runs, and whether it answers. */
function ReachLine({
  state,
}: {
  readonly state: Extract<WelcomeState, { kind: "searching" | "fresh" | "starting" | "found" }>;
}): JSX.Element {
  switch (state.kind) {
    case "searching":
      return (
        <p className="reach" role="status">
          <span className="spin" />
          Looking for Hercule on this Mac…
        </p>
      );
    case "found":
      return (
        <p className="reach">
          <span className="dot-ok" />
          <span>
            <b>Hercule is running on this Mac</b>
          </span>
          <span className="spacer" />
          <span className="mono">{state.address}</span>
        </p>
      );
    case "fresh":
    case "starting":
      return (
        <p className="reach reach--off">
          <span className="dot-ok" />
          <span>
            <b>Hercule will run on this Mac</b>
          </span>
          <span className="spacer" />
          <span>starts at login</span>
        </p>
      );
  }
}

/**
 * Renders the welcome when there is no Hercule on this Mac to start. It is
 * drawn as a start error whose line says so, followed by the command that
 * installs Hercule, with Copy, then `tryAgain`.
 */
function NotInstalled({ tryAgain }: { readonly tryAgain: ReactNode }): JSX.Element {
  const commandRef = useRef<HTMLElement>(null);
  return (
    <>
      <h1 className="st-h">Hercule didn’t start</h1>
      <p className="st-sub">Starting Hercule on this Mac stopped with this error:</p>
      <Warning icon={<ShieldIcon size={14} />}>
        Hercule is not installed on this Mac. Install it by running this command in Terminal, then
        try again.
      </Warning>
      <div className="cmd">
        <span ref={commandRef}>{INSTALLER_COMMAND}</span>
        <span className="spacer" />
        <CopyButton targetRef={commandRef} />
      </div>
      {tryAgain}
    </>
  );
}

/**
 * Renders the screen that connects to Hercule on another machine: one
 * address field, Continue and, when `onUseThisMac` is given, Use this Mac.
 * `error` is the last attempt's failure, drawn under the field. While
 * `saving`, Continue is busy.
 */
export function ConnectElsewhere({
  address,
  onAddressChange,
  error,
  saving,
  onSubmit,
  onUseThisMac,
}: {
  readonly address: string;
  readonly onAddressChange: (address: string) => void;
  readonly error: ReactNode;
  readonly saving: boolean;
  readonly onSubmit: () => void;
  readonly onUseThisMac: (() => void) | null;
}): JSX.Element {
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!saving) onSubmit();
  };
  return (
    <form onSubmit={submit}>
      <h1 className="st-h">Connect to Hercule on another machine</h1>
      <p className="st-sub">
        Paste the address of the machine that runs Hercule. If Hercule isn’t set up there yet, paste
        its setup address instead.
      </p>
      <div className="st-form">
        <FormField
          label="Address"
          error={error}
          hint={
            <>
              On that machine, <span className="mono">hercule setup-url</span> prints the setup
              address.
            </>
          }
        >
          <input
            className="mono"
            value={address}
            onChange={(event) => onAddressChange(event.target.value)}
            placeholder="http://build-box-1:4937"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            autoFocus
          />
        </FormField>
      </div>
      <div className="st-actions">
        <button
          type="submit"
          className="btn btn--accent btn--lg"
          aria-busy={saving ? true : undefined}
        >
          {saving ? (
            <>
              <span className="spin" />
              Connecting…
            </>
          ) : (
            "Continue"
          )}
        </button>
        {onUseThisMac === null ? null : (
          <button type="button" className="btn btn--quiet" onClick={onUseThisMac}>
            Use this Mac
          </button>
        )}
      </div>
    </form>
  );
}
