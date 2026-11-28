/**
 * The setup of a Connection in a glass dialog, which Settings > Connections
 * opens from Add a Connection and from a row's Reconnect. Presentational.
 */
import type { FormEvent, JSX, ReactNode, RefObject } from "react";
import {
  formatUrlWithoutScheme,
  listCredentialFields,
  type ConnectionType,
  type FlowSwitch,
  type PluginIdentity,
  type SetupFlow,
  type SignInEnding,
} from "@hercule/client-core";
import { ClockIcon } from "../../../icons/clock";
import { CloseIcon } from "../../../icons/close";
import { ExternalIcon } from "../../../icons/external";
import { KeyIcon } from "../../../icons/key";
import { QuestionIcon } from "../../../icons/question";
import { GlassDialog } from "../../glass-dialog";
import {
  CredentialFields,
  DeviceCodeSteps,
  MarkedRow,
  MarkedRows,
  WaitLine,
  Warning,
} from "../../step";
import { ConnectionTypeMark } from "./connection-type-mark";
import "./connection-setup.css";

/**
 * Where the setup stands:
 *
 * - `form`: the chosen `flow` before anything is sent. For `credentials`,
 *   the fields with `fieldErrors` under each; for `device` and `oauth`, the
 *   button that starts the sign-in. `busy` while the controller answers, and
 *   `error` for a failure that belongs to no field.
 * - `code`: the user enters `code` at `verificationUri`; `wait` is the line
 *   under the steps.
 * - `ended`: the sign-in with a code ended without a Connection.
 * - `browser`: the provider's sign-in page is open in the browser at
 *   `authorizationUrl`, and the setup waits for the Connection.
 * - `unsupported`: the setup takes a pairing, which is not built, or a step
 *   this version does not know (`flow` absent).
 *
 * In `code` and `browser`, `linkError` says why the sign-in page did not
 * open, or is null.
 */
export type ConnectionSetupState =
  | {
      readonly kind: "form";
      readonly flow: Exclude<SetupFlow, "pairing">;
      readonly busy: boolean;
      readonly fieldErrors: Readonly<Record<string, string>>;
      readonly error: string | null;
    }
  | {
      readonly kind: "code";
      readonly code: string;
      readonly verificationUri: string;
      readonly wait: string;
      readonly linkError: string | null;
    }
  | SignInEnding
  | {
      readonly kind: "browser";
      readonly authorizationUrl: string;
      readonly linkError: string | null;
    }
  | { readonly kind: "unsupported"; readonly flow?: "pairing" };

/** What the setup's buttons and fields do. */
export interface ConnectionSetupActions {
  readonly onFieldChange: (name: string, value: string) => void;
  /** Sends the credentials, or starts the sign-in of the form's flow. */
  readonly onSubmit: () => void;
  /** Shows the form of another flow the type offers. */
  readonly onSwitchFlow: (flow: SetupFlow) => void;
  /** Stops waiting for the code to be approved, and shows the form again. */
  readonly onCancelCode: () => void;
  /** Asks for a new code after a sign-in ended. */
  readonly onStartAgain: () => void;
  /** Opens `url` in the default browser. */
  readonly onOpen: (url: string) => void;
}

const ENDING_ICONS = {
  expired: <ClockIcon size={14} />,
  denied: <CloseIcon size={14} />,
  failed: <QuestionIcon size={14} />,
} as const;

/**
 * Renders the setup of a Connection of `type` in `state`, in a glass dialog
 * headed `heading`, such as "Connect GitHub". The type's mark is drawn from
 * `plugins`, and `values` holds what the credential fields hold.
 * `redirectUri` is the address the user must register with the OAuth
 * provider, absent when the type's plugin ships a client that registered its
 * own, and `flowSwitches` the links to the type's other flows, which the form and an
 * ended sign-in show.
 *
 * Esc, a click on the scrim and Cancel close the dialog through `dialogRef`;
 * `onClose` is called whenever it closes, and the caller then unmounts it.
 */
export function ConnectionSetup({
  dialogRef,
  heading,
  type,
  plugins,
  state,
  values,
  redirectUri,
  flowSwitches,
  actions,
  onClose,
}: {
  readonly dialogRef: RefObject<HTMLDialogElement | null>;
  readonly heading: string;
  readonly type: ConnectionType;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly state: ConnectionSetupState;
  readonly values: Readonly<Record<string, string>>;
  readonly redirectUri: string | undefined;
  readonly flowSwitches: ReadonlyArray<FlowSwitch>;
  readonly actions: ConnectionSetupActions;
  readonly onClose: () => void;
}): JSX.Element {
  const renderMark = (size: number): JSX.Element => (
    <ConnectionTypeMark type={type.type} plugins={plugins} size={size} />
  );
  const close = (): void => dialogRef.current?.close();
  const cancelButton = (
    <button type="button" className="btn btn--quiet" onClick={close}>
      Cancel
    </button>
  );
  return (
    <GlassDialog dialogRef={dialogRef} className="setup-dialog" label={heading} onClose={onClose}>
      <div className="pop-h">
        <b>{heading}</b>
      </div>
      <div className="pop-sec setup-dialog-body">
        {state.kind === "form" ? (
          <SetupForm
            type={type}
            state={state}
            values={values}
            redirectUri={redirectUri}
            actions={actions}
            cancelButton={cancelButton}
            switches={
              <FlowSwitches
                switches={flowSwitches}
                switchMark={renderMark(14)}
                // A save cannot be called back: the Connection is made even if the
                // dialog moves on. A sign-in that is starting can be, so its form
                // still offers the other flows.
                disabled={state.flow === "credentials" && state.busy}
                actions={actions}
              />
            }
          />
        ) : state.kind === "code" ? (
          <MarkedRows>
            <MarkedRow
              mark={renderMark(18)}
              name={type.displayName}
              detail={formatUrlWithoutScheme(state.verificationUri)}
              end={
                <button
                  type="button"
                  className="btn btn--sm btn--quiet"
                  onClick={actions.onCancelCode}
                >
                  Cancel
                </button>
              }
            >
              <DeviceCodeSteps
                code={state.code}
                openText={`Open ${type.displayName}, enter the code and approve Hercule.`}
                openLabel={`Open ${type.displayName}`}
                onOpen={() => actions.onOpen(state.verificationUri)}
                end={
                  <>
                    <WaitLine text={state.wait} />
                    <LinkError text={state.linkError} />
                  </>
                }
              />
            </MarkedRow>
          </MarkedRows>
        ) : state.kind === "ended" ? (
          <>
            <Warning icon={ENDING_ICONS[state.status]}>
              <b>{state.line}</b> {state.next}
            </Warning>
            <div className="setup-acts">
              {cancelButton}
              <button
                type="button"
                className="btn btn--accent"
                onClick={actions.onStartAgain}
                autoFocus
              >
                Start again
              </button>
            </div>
            <FlowSwitches
              switches={flowSwitches}
              switchMark={renderMark(14)}
              disabled={false}
              actions={actions}
            />
          </>
        ) : state.kind === "browser" ? (
          <MarkedRows>
            <MarkedRow
              mark={renderMark(18)}
              name="Finish in your browser"
              detail={formatUrlWithoutScheme(state.authorizationUrl)}
              end={
                <span className="setup-row-acts">
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => actions.onOpen(state.authorizationUrl)}
                    // The button that started the sign-in is gone, and the focus with it.
                    autoFocus
                  >
                    <ExternalIcon size={14} />
                    Open again
                  </button>
                  <button type="button" className="btn btn--sm btn--quiet" onClick={close}>
                    Cancel
                  </button>
                </span>
              }
            >
              {/* A failed sign-in creates no Connection, so only the browser can show it.
                  The user may also give up in the browser, which then never answers, so
                  the line has no spinner: a spinner promises a wait that ends. */}
              <span className="wait" role="status">
                Waiting for {type.displayName}. If the sign-in fails, the browser says why.
              </span>
              <LinkError text={state.linkError} />
            </MarkedRow>
          </MarkedRows>
        ) : (
          <>
            <p className="setup-lead">
              {state.flow === "pairing"
                ? "Pairing a chat account is not built yet."
                : `Setting up ${type.displayName} takes a step this version of Hercule does not know.`}
            </p>
            <div className="setup-acts">
              <button type="button" className="btn btn--quiet" onClick={close}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </GlassDialog>
  );
}

/**
 * Renders the form of one flow: for a sign-in, a line on what the sign-in
 * does, then the type's own instructions, then the
 * credential fields, or the redirect URI to register for OAuth when there is
 * one, then Cancel
 * and the button that sends the form, and `switches`, the links to the
 * type's other flows. While the credentials are being sent, the fields
 * cannot be edited, so what was sent stays on screen.
 */
function SetupForm({
  type,
  state,
  values,
  redirectUri,
  actions,
  cancelButton,
  switches,
}: {
  readonly type: ConnectionType;
  readonly state: Extract<ConnectionSetupState, { kind: "form" }>;
  readonly values: Readonly<Record<string, string>>;
  readonly redirectUri: string | undefined;
  readonly actions: ConnectionSetupActions;
  readonly cancelButton: JSX.Element;
  readonly switches: ReactNode;
}): JSX.Element {
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!state.busy) actions.onSubmit();
  };
  const credentials = state.flow === "credentials";
  const submitLabel = credentials
    ? state.busy
      ? "Connecting…"
      : "Connect"
    : `Sign in with ${type.displayName}`;
  return (
    <form onSubmit={submit}>
      {state.flow === "device" ? (
        <p className="setup-lead">{`You get a code to enter on ${type.displayName}.`}</p>
      ) : state.flow === "oauth" ? (
        <p className="setup-lead">{`You sign in to ${type.displayName} in your browser.`}</p>
      ) : null}
      {type.setup.map((step, index) =>
        // A checklist step holds the provider's own instructions, shown as written.
        step.kind === "checklist" ? (
          <p key={index} className="setup-lead">
            {step.markdown}
          </p>
        ) : null,
      )}
      {state.flow === "credentials" ? (
        <CredentialFields
          fields={listCredentialFields(type)}
          values={values}
          errors={state.fieldErrors}
          readOnly={state.busy}
          onChange={(name, value) => actions.onFieldChange(name, value)}
        />
      ) : state.flow === "oauth" && redirectUri !== undefined ? (
        <>
          <p className="setup-lead">Register this redirect URI with {type.displayName}:</p>
          <p className="setup-uri mono">{redirectUri}</p>
        </>
      ) : null}
      {state.error === null ? null : (
        <p className="fl-err setup-error" role="alert">
          {state.error}
        </p>
      )}
      <div className="setup-acts">
        {cancelButton}
        <button
          type="submit"
          className="btn btn--accent"
          aria-busy={state.busy ? true : undefined}
          aria-disabled={state.busy ? true : undefined}
          // With no field to type in, the first button would be Cancel, and
          // Enter would close the dialog instead of signing in.
          autoFocus={!credentials}
        >
          {state.busy ? <span className="spin" /> : null}
          {submitLabel}
        </button>
      </div>
      {switches}
    </form>
  );
}

/**
 * Renders a link for each of `switches`, such as "Paste a token instead",
 * under a rule, as the first run's GitHub step offers the token. A sign-in
 * link carries `switchMark`, the type's mark. `disabled` while the form
 * cannot be left. Renders nothing when there is no other flow.
 */
function FlowSwitches({
  switches,
  switchMark,
  disabled,
  actions,
}: {
  readonly switches: ReadonlyArray<FlowSwitch>;
  readonly switchMark: JSX.Element;
  readonly disabled: boolean;
  readonly actions: ConnectionSetupActions;
}): JSX.Element | null {
  if (switches.length === 0) return null;
  return (
    <div className="setup-switches">
      {switches.map(({ flow, label }) => (
        <p key={flow} className="st-note">
          {flow === "credentials" ? <KeyIcon size={14} /> : switchMark}
          <span>
            <button
              type="button"
              className="link"
              disabled={disabled}
              onClick={() => actions.onSwitchFlow(flow)}
            >
              {label}
            </button>
          </span>
        </p>
      ))}
    </div>
  );
}

/** Renders `text`, why the sign-in page did not open, or nothing when `text` is null. */
function LinkError({ text }: { readonly text: string | null }): JSX.Element | null {
  return text === null ? null : (
    <p className="fl-err setup-link-error" role="alert">
      {text}
    </p>
  );
}
