/**
 * The setup of a Connection in a glass dialog, which Settings > Connections
 * opens from Add a Connection and from a row's Reconnect. Presentational.
 */
import type { FormEvent, JSX, RefObject } from "react";
import {
  buildFlowSwitchLabel,
  formatUrlWithoutScheme,
  listCredentialFields,
  listSetupFlows,
  parsePluginId,
  type ConnectionType,
  type PluginIdentity,
  type SetupFlow,
  type SignInEnding,
} from "@hercule/client-core";
import { ChatIcon } from "../../../icons/chat";
import { ClockIcon } from "../../../icons/clock";
import { CloseIcon } from "../../../icons/close";
import { KeyIcon } from "../../../icons/key";
import { QuestionIcon } from "../../../icons/question";
import { PluginMark } from "../../../marks";
import { GlassDialog } from "../../glass-dialog";
import { DeviceCodeSteps, FormField, MarkedRow, MarkedRows, WaitLine, Warning } from "../../step";
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
    }
  | SignInEnding
  | { readonly kind: "browser"; readonly authorizationUrl: string }
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
 * `plugins`, and `values` holds what the credential fields hold. `redirectUri` is the
 * address the OAuth provider must have registered.
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
  actions,
  onClose,
}: {
  readonly dialogRef: RefObject<HTMLDialogElement | null>;
  readonly heading: string;
  readonly type: ConnectionType;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly state: ConnectionSetupState;
  readonly values: Readonly<Record<string, string>>;
  readonly redirectUri: string;
  readonly actions: ConnectionSetupActions;
  readonly onClose: () => void;
}): JSX.Element {
  const renderMark = (size: number): JSX.Element => (
    <PluginMark pluginId={parsePluginId(type.type) ?? type.type} plugins={plugins} size={size} />
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
            switchMark={renderMark(14)}
            state={state}
            values={values}
            redirectUri={redirectUri}
            actions={actions}
            cancelButton={cancelButton}
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
                end={<WaitLine text={state.wait} />}
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
              <button type="button" className="btn btn--accent" onClick={actions.onStartAgain}>
                Start again
              </button>
            </div>
            <FlowSwitches
              type={type}
              current="device"
              switchMark={renderMark(14)}
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
                <button type="button" className="btn btn--sm btn--quiet" onClick={close}>
                  Cancel
                </button>
              }
            >
              {/* A failed sign-in creates no Connection, so only the browser can show it. */}
              <WaitLine
                text={`Waiting for ${type.displayName}. If the sign-in fails, the browser says why.`}
              />
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
              <button type="button" className="btn" onClick={close}>
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
 * Renders the form of one flow: the type's own instructions, then the
 * credential fields, or the redirect URI to register for OAuth, then Cancel
 * and the button that sends the form, and the links to the type's other flows.
 */
function SetupForm({
  type,
  switchMark,
  state,
  values,
  redirectUri,
  actions,
  cancelButton,
}: {
  readonly type: ConnectionType;
  readonly switchMark: JSX.Element;
  readonly state: Extract<ConnectionSetupState, { kind: "form" }>;
  readonly values: Readonly<Record<string, string>>;
  readonly redirectUri: string;
  readonly actions: ConnectionSetupActions;
  readonly cancelButton: JSX.Element;
}): JSX.Element {
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!state.busy) actions.onSubmit();
  };
  const submitLabel = state.flow === "credentials" ? "Connect" : `Sign in with ${type.displayName}`;
  return (
    <form onSubmit={submit}>
      {type.setup.map((step, index) =>
        // A checklist step holds the provider's own instructions, shown as written.
        step.kind === "checklist" ? (
          <p key={index} className="setup-lead">
            {step.markdown}
          </p>
        ) : null,
      )}
      {state.flow === "credentials" ? (
        <div className="setup-fields">
          {listCredentialFields(type).map((field, index) => (
            <FormField
              key={field.name}
              label={field.label}
              hint={field.help}
              error={state.fieldErrors[field.name] ?? null}
            >
              <input
                // A pasted credential is never read back, so it is never prefilled.
                type="password"
                className="mono"
                value={values[field.name] ?? ""}
                onChange={(event) => actions.onFieldChange(field.name, event.target.value)}
                spellCheck={false}
                autoComplete="off"
                autoFocus={index === 0}
              />
            </FormField>
          ))}
        </div>
      ) : state.flow === "oauth" ? (
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
        >
          {state.busy ? <span className="spin" /> : null}
          {submitLabel}
        </button>
      </div>
      <FlowSwitches type={type} current={state.flow} switchMark={switchMark} actions={actions} />
    </form>
  );
}

/**
 * Renders a link to each flow the type offers besides `current`, such as
 * "Paste a token instead", under a rule, as the first run's GitHub step
 * offers the token. A sign-in link carries `switchMark`, the type's mark.
 * Renders nothing for a type with one flow.
 */
function FlowSwitches({
  type,
  current,
  switchMark,
  actions,
}: {
  readonly type: ConnectionType;
  readonly current: SetupFlow;
  readonly switchMark: JSX.Element;
  readonly actions: ConnectionSetupActions;
}): JSX.Element | null {
  const others = listSetupFlows(type).filter((flow) => flow !== current);
  if (others.length === 0) return null;
  return (
    <div className="setup-switches">
      {others.map((flow) => (
        <p key={flow} className="st-note">
          {flow === "credentials" ? (
            <KeyIcon size={14} />
          ) : flow === "pairing" ? (
            <ChatIcon size={14} />
          ) : (
            switchMark
          )}
          <span>
            <button type="button" className="link" onClick={() => actions.onSwitchFlow(flow)}>
              {buildFlowSwitchLabel(flow, type)}
            </button>
          </span>
        </p>
      ))}
    </div>
  );
}
