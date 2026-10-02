/**
 * The first run's GitHub step: sign in with GitHub with a code, or paste a
 * personal access token. Presentational.
 */
import type { FormEvent, JSX } from "react";
import { GitHubMark } from "../../logos";
import { ClockIcon, CloseIcon, ExternalIcon, KeyIcon, QuestionIcon } from "../../icons";
import {
  DeviceCodeSteps,
  DoneMark,
  FormField,
  MarkedCard,
  MarkedRow,
  MarkedRows,
  WaitLine,
  Warning,
} from "../step";
import { StepKicker } from "./first-run-frame";

/**
 * GitHub's page for a new classic token, with the scopes Hercule's GitHub
 * Connection reads with already ticked (spec 08 §9.3).
 */
export const GITHUB_TOKEN_URL =
  "https://github.com/settings/tokens/new?scopes=repo,read:org,notifications,workflow&description=Hercule";

/**
 * Where the GitHub step stands:
 *
 * - `start`: nothing started yet; `starting` while the app asks the
 *   controller for a code.
 * - `code`: the user enters `code` on GitHub at `verificationUri`; `wait`
 *   is the line under the steps.
 * - `ended`: the sign-in ended without a Connection, with `line` and `next`.
 * - `token`: the token form; `checking` while the controller checks the
 *   token, and `error` when it refused it.
 * - `connected`: GitHub is connected as `account`.
 */
export type GitHubStepState =
  | { readonly kind: "start"; readonly starting: boolean }
  | {
      readonly kind: "code";
      readonly code: string;
      readonly verificationUri: string;
      readonly wait: string;
    }
  | {
      readonly kind: "ended";
      readonly status: "expired" | "denied" | "failed";
      readonly line: string;
      readonly next: string;
    }
  | { readonly kind: "token"; readonly checking: boolean; readonly error: string | null }
  | { readonly kind: "connected"; readonly account: string };

const ENDING_ICONS = {
  expired: <ClockIcon size={14} />,
  denied: <CloseIcon size={14} />,
  failed: <QuestionIcon size={14} />,
} as const;

/** What the GitHub step's buttons and fields do. */
export interface GitHubStepActions {
  /** Starts a sign-in with a code: Sign in with GitHub, Start again. */
  readonly onSignIn: () => void;
  /** Stops waiting for the code to be approved. */
  readonly onCancel: () => void;
  /** Opens `url` in the default browser. */
  readonly onOpen: (url: string) => void;
  /** Shows the token form. */
  readonly onUseToken: () => void;
  readonly onTokenChange: (token: string) => void;
  /** Sends the token in the form. */
  readonly onConnectToken: () => void;
  /** Puts the step off. */
  readonly onSkip: () => void;
  /** Moves on once GitHub is connected. */
  readonly onContinue: () => void;
}

/** Renders the GitHub step in `state`; `token` is what the token field holds. */
export function GitHubStep({
  state,
  token,
  actions,
}: {
  readonly state: GitHubStepState;
  readonly token: string;
  readonly actions: GitHubStepActions;
}): JSX.Element {
  const skip = (
    <button
      type="button"
      className="btn btn--quiet"
      disabled={state.kind === "token" && state.checking}
      onClick={actions.onSkip}
    >
      Skip for now
    </button>
  );
  const toToken = (
    <p className="st-note">
      <KeyIcon size={14} />
      <span>
        Rather use a personal access token?{" "}
        <button type="button" className="link" onClick={actions.onUseToken}>
          Paste a token instead
        </button>
      </span>
    </p>
  );
  switch (state.kind) {
    case "connected":
      return (
        <>
          <StepKicker step="github" />
          <h1 className="st-h">GitHub is connected</h1>
          <p className="st-sub">What deserves your attention shows up in Intake as a Proposal.</p>
          <MarkedCard
            mark={<GitHubMark size={18} />}
            name={`Connected as ${state.account}`}
            detail="github.com"
            end={<DoneMark />}
          />
          <div className="st-actions">
            <button type="button" className="btn btn--accent btn--lg" onClick={actions.onContinue}>
              Continue
            </button>
          </div>
        </>
      );
    case "token":
      return <TokenForm state={state} token={token} actions={actions} skip={skip} />;
    case "code":
      return (
        <>
          <GitHubHeading />
          <MarkedRows>
            <MarkedRow
              mark={<GitHubMark size={18} />}
              name="GitHub"
              detail={readHostAndPath(state.verificationUri)}
              end={
                <button type="button" className="btn btn--sm btn--quiet" onClick={actions.onCancel}>
                  Cancel
                </button>
              }
            >
              <DeviceCodeSteps
                code={state.code}
                openText="Open GitHub, enter the code and approve Hercule."
                openLabel="Open GitHub"
                onOpen={() => actions.onOpen(state.verificationUri)}
                end={<WaitLine text={state.wait} />}
              />
            </MarkedRow>
          </MarkedRows>
          <div className="st-actions">
            <button type="button" className="btn btn--accent btn--lg" disabled>
              Continue
            </button>
            {skip}
          </div>
        </>
      );
    case "ended":
      return (
        <>
          <GitHubHeading />
          <Warning icon={ENDING_ICONS[state.status]}>
            <b>{state.line}</b> {state.next}
            {state.status === "failed" ? (
              <>
                <br />
                <button type="button" className="btn btn--sm" onClick={actions.onUseToken}>
                  <KeyIcon size={14} />
                  Paste a token instead
                </button>
              </>
            ) : null}
          </Warning>
          <div className="st-actions">
            <button type="button" className="btn btn--accent btn--lg" onClick={actions.onSignIn}>
              Start again
            </button>
            {skip}
          </div>
          {/* When the sign-in itself failed, the token is the way on, so it moved up into the warning. */}
          {state.status === "failed" ? null : toToken}
        </>
      );
    case "start":
      return (
        <>
          <GitHubHeading />
          <div className="st-actions">
            <button
              type="button"
              className="btn btn--accent btn--lg"
              aria-busy={state.starting ? true : undefined}
              onClick={actions.onSignIn}
            >
              {state.starting ? <span className="spin" /> : <GitHubMark size={16} />}
              Sign in with GitHub
            </button>
            {skip}
          </div>
          {toToken}
        </>
      );
  }
}

/** Renders the GitHub step's kicker, heading and the line under it. */
function GitHubHeading(): JSX.Element {
  return (
    <>
      <StepKicker step="github" />
      <h1 className="st-h">Connect GitHub</h1>
      <p className="st-sub">
        Hercule watches your repositories for new issues, reviews and failed checks. Triage reads
        them and brings you the ones that need work, ready to accept or dismiss.
      </p>
    </>
  );
}

/**
 * Returns `url` without its scheme, such as `github.com/login/device`, or
 * `url` unchanged when it does not parse.
 */
function readHostAndPath(url: string): string {
  if (!URL.canParse(url)) return url;
  const { host, pathname } = new URL(url);
  return `${host}${pathname === "/" ? "" : pathname}`;
}

/** Renders the token form, with `skip` beside Connect. */
function TokenForm({
  state,
  token,
  actions,
  skip,
}: {
  readonly state: Extract<GitHubStepState, { kind: "token" }>;
  readonly token: string;
  readonly actions: GitHubStepActions;
  readonly skip: JSX.Element;
}): JSX.Element {
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!state.checking) actions.onConnectToken();
  };
  return (
    <form onSubmit={submit}>
      <StepKicker step="github" />
      <h1 className="st-h">Connect GitHub with a token</h1>
      <p className="st-sub">
        Create a personal access token on GitHub, then paste it here. Triage reads your repositories
        with it, as it would after signing in.
      </p>
      <div className="st-form">
        <FormField
          label="Personal access token"
          aside={
            <button
              type="button"
              className="link"
              title={GITHUB_TOKEN_URL}
              onClick={() => actions.onOpen(GITHUB_TOKEN_URL)}
            >
              Create one on GitHub <ExternalIcon size={12} />
            </button>
          }
          error={state.error}
          hint="The link opens GitHub with the scopes Hercule needs already ticked. Hercule keeps the token encrypted."
        >
          <input
            className="mono"
            value={token}
            onChange={(event) => actions.onTokenChange(event.target.value)}
            placeholder="github_pat_… or ghp_…"
            spellCheck={false}
            autoComplete="off"
            autoFocus
          />
        </FormField>
      </div>
      <div className="st-actions">
        <button
          type="submit"
          className="btn btn--accent btn--lg"
          aria-busy={state.checking ? true : undefined}
        >
          {state.checking ? (
            <>
              <span className="spin" />
              Checking the token…
            </>
          ) : (
            "Connect"
          )}
        </button>
        {skip}
      </div>
      <p className="st-note">
        <GitHubMark size={14} />
        <span>
          Rather not handle a token?{" "}
          <button type="button" className="link" onClick={actions.onSignIn}>
            Sign in with GitHub instead
          </button>
        </span>
      </p>
    </form>
  );
}
