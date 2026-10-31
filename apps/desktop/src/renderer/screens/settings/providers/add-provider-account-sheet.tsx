import {
  useEffect,
  useId,
  useRef,
  type FormEvent,
  type JSX,
  type ReactNode,
  type RefObject,
} from "react";
import type { CredentialField, HarnessLoginMethod, SignInRunnerOption } from "@hercule/client-core";
import { CloseIcon } from "../../../icons/close";
import { ShieldIcon } from "../../../icons/shield";
import { GlassDialog } from "../../glass-dialog";
import { CredentialFields, DoneMark } from "../../step";
import {
  AccountKindCards,
  ProviderTiles,
  RunnerCards,
  type AccountKindChoice,
  type ProviderTile,
} from "./add-account-choices";
import "./providers.css";
import "./add-provider-account-sheet.css";

/**
 * What the add-account sheet asks now. The sheet draws the screen it is given
 * and decides nothing; `client-core` decides which screens a kind needs, and
 * in which order.
 *
 * - `provider`: one tile for each provider; picking one moves on.
 * - `account-kind`: the kinds of the chosen provider, one of them picked.
 * - `credentials`: a masked field for each of `fields`, under `lead`, the
 *   kind's own instructions, when it has any. `errors` holds a message for a
 *   field by name. While `busy`, the fields cannot be edited.
 * - `label`: the label, under `prompt`. `hint` and `error` are shown under the
 *   field, the error in place of the hint. While `busy`, the label cannot be
 *   edited.
 * - `sign-in`: the machines the login can run on and the one chosen.
 *   `signedInOn` is the name of the machine the account has signed in on, once
 *   it has.
 */
export type AddProviderAccountScreen =
  | {
      readonly kind: "provider";
      readonly providers: ReadonlyArray<ProviderTile>;
      readonly onPick: (providerId: string) => void;
    }
  | {
      readonly kind: "account-kind";
      readonly kinds: ReadonlyArray<AccountKindChoice>;
      readonly pickedId: string | null;
      readonly onPick: (kindId: string) => void;
    }
  | {
      readonly kind: "credentials";
      readonly lead: string | null;
      readonly fields: ReadonlyArray<CredentialField>;
      readonly values: Readonly<Record<string, string>>;
      readonly errors: Readonly<Record<string, string>>;
      readonly busy: boolean;
      readonly onChange: (name: string, value: string) => void;
    }
  | {
      readonly kind: "label";
      readonly prompt: string;
      readonly value: string;
      readonly placeholder: string;
      readonly hint: string;
      readonly error: string | null;
      readonly busy: boolean;
      readonly onChange: (label: string) => void;
    }
  | {
      readonly kind: "sign-in";
      readonly method: HarnessLoginMethod;
      readonly options: ReadonlyArray<SignInRunnerOption>;
      readonly chosenRunnerId: string | null;
      readonly signedInOn: string | null;
      readonly onChoose: (runnerId: string) => void;
    };

/** The sheet's main button, at the end of the footer. */
export interface AddAccountPrimaryButton {
  /**
   * The words on the button. While `busy` they say what is running, such as
   * "Checking the key…", because the sheet draws no spinner: a spinner is
   * allowed only while Hercule starts or a login waits (spec 17, Rules).
   */
  readonly label: string;
  /** Whether it cannot be pressed now, for want of what the screen asks. */
  readonly disabled: boolean;
  /** Whether the press is still running. */
  readonly busy: boolean;
  readonly onPress: () => void;
}

/** Renders the line that tells the user where a key or a token is kept. */
function EncryptionNote(): JSX.Element {
  return (
    <span className="aa-note">
      <ShieldIcon size={13} />
      Keys and tokens stay encrypted on the controller.
    </span>
  );
}

/** Renders the line above the machines: what the login does and where it ends up. */
function SignInLead({ method }: { readonly method: HarnessLoginMethod }): JSX.Element {
  return (
    <p className="aa-lead">
      {method === "create-token"
        ? "Pick a machine that has Claude Code. Hercule makes a token there that works on every machine and lasts a year. You open a link and paste the code it shows."
        : "Pick the machine to sign in on. The login stays on that machine; you sign in on the others later, from the account."}
    </p>
  );
}

/** Renders the body of `screen`. */
function ScreenBody({ screen }: { readonly screen: AddProviderAccountScreen }): ReactNode {
  switch (screen.kind) {
    case "provider":
      return <ProviderTiles providers={screen.providers} onPick={screen.onPick} />;
    case "account-kind":
      return (
        <>
          <p className="aa-lead">How should Hercule sign in?</p>
          <AccountKindCards
            kinds={screen.kinds}
            pickedId={screen.pickedId}
            onPick={screen.onPick}
          />
        </>
      );
    case "credentials":
      return (
        <>
          {screen.lead === null ? null : <p className="aa-lead aa-lead--text">{screen.lead}</p>}
          <CredentialFields
            fields={screen.fields}
            values={screen.values}
            errors={screen.errors}
            readOnly={screen.busy}
            onChange={screen.onChange}
          />
          <EncryptionNote />
        </>
      );
    case "label":
      return (
        <>
          <p className="aa-lead">{screen.prompt}</p>
          <div className="pa-name">
            <span className={screen.error === null ? "field" : "field is-bad"}>
              <input
                type="text"
                aria-label="Name"
                placeholder={screen.placeholder}
                value={screen.value}
                spellCheck={false}
                autoComplete="off"
                autoFocus
                readOnly={screen.busy}
                onChange={(event) => screen.onChange(event.target.value)}
              />
            </span>
            {screen.error === null ? (
              <p className="pa-hint">{screen.hint}</p>
            ) : (
              <p className="fl-err" role="alert">
                {screen.error}
              </p>
            )}
          </div>
        </>
      );
    case "sign-in":
      return (
        <>
          <SignInLead method={screen.method} />
          <RunnerCards
            options={screen.options}
            chosenRunnerId={screen.chosenRunnerId}
            onChoose={screen.onChoose}
          />
          {screen.signedInOn === null ? null : (
            <p className="aa-done">
              <DoneMark>{`Signed in on ${screen.signedInOn}`}</DoneMark>
            </p>
          )}
        </>
      );
  }
}

/** The props of `AddProviderAccountSheet`. */
export interface AddProviderAccountSheetProps {
  readonly dialogRef: RefObject<HTMLDialogElement | null>;
  readonly title: string;
  /** The mark of the chosen provider, or `null` on the first step. */
  readonly mark: ReactNode;
  readonly screen: AddProviderAccountScreen;
  /** Why the last press failed, or `null`. */
  readonly error: string | null;
  /** Goes to the step before, or `null` when there is none to go back to. */
  readonly onBack: (() => void) | null;
  readonly cancelLabel: string;
  /**
   * The main button, or `null` when the screen moves on by itself. While it is
   * `busy`, the sheet cannot be left: Back, the cancel button, the close
   * button, Esc and the scrim do nothing, so the press cannot finish with
   * nobody to receive its result.
   */
  readonly primary: AddAccountPrimaryButton | null;
  /** Called whenever the dialog closes; the caller then unmounts it. */
  readonly onClose: () => void;
}

/**
 * Renders the add-account sheet: a glass dialog over the Providers page (and
 * over the first run's card), titled `title`, with the provider's `mark`
 * beside it once a provider is chosen. It shows `screen`, then `error`, the
 * reason the last press failed, then the footer: Back at the start when
 * `onBack` is given, the cancel button, whose label is `cancelLabel` ("Cancel",
 * or "Discard" once the account exists but is not signed in), and `primary`,
 * if the screen has one. Enter in a field presses `primary`.
 *
 * The close button, the cancel button, Esc and a click on the scrim all close
 * the dialog, except while `primary` is busy; `onClose` is called whenever it closes, and the caller then
 * unmounts it.
 */
export function AddProviderAccountSheet({
  dialogRef,
  title,
  mark,
  screen,
  error,
  onBack,
  cancelLabel,
  primary,
  onClose,
}: AddProviderAccountSheetProps): JSX.Element {
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  // A modal dialog focuses its first control, which is the close button. The
  // user is there to choose, so the focus goes to the control marked
  // `data-initial-focus`, on every screen. The dialog is open by now: its own
  // effect runs before this one.
  useEffect(() => {
    formRef.current?.querySelector<HTMLElement>("[data-initial-focus]")?.focus();
  }, [screen.kind]);
  const locked = primary?.busy === true;
  const close = (): void => dialogRef.current?.close();
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (primary !== null && !primary.disabled && !primary.busy) primary.onPress();
  };
  return (
    <GlassDialog
      dialogRef={dialogRef}
      className="account-sheet add-account-sheet"
      label={title}
      locked={locked}
      onClose={onClose}
    >
      <div className="pa-sheet-h">
        {mark === null ? null : <span className="pa-sheet-mark">{mark}</span>}
        <span className="pa-sheet-title">
          <h2>{title}</h2>
        </span>
        <button
          type="button"
          className="icon-btn"
          title="Close"
          aria-label="Close"
          disabled={locked}
          onClick={close}
        >
          <CloseIcon size={14} />
        </button>
      </div>
      <form id={formId} ref={formRef} className="pa-sheet-b" onSubmit={submit}>
        <ScreenBody screen={screen} />
        {error === null ? null : (
          <p className="fl-err aa-error" role="alert">
            {error}
          </p>
        )}
      </form>
      <div className="pa-sheet-f">
        <span className="aa-foot-start">
          {onBack === null ? null : (
            <button type="button" className="btn btn--quiet" disabled={locked} onClick={onBack}>
              Back
            </button>
          )}
          {screen.kind === "provider" ? <EncryptionNote /> : null}
        </span>
        <button type="button" className="btn" disabled={locked} onClick={close}>
          {cancelLabel}
        </button>
        {primary === null ? null : (
          <button
            type="submit"
            form={formId}
            className="btn btn--accent"
            disabled={primary.disabled}
            aria-busy={primary.busy ? true : undefined}
            aria-disabled={primary.busy ? true : undefined}
          >
            {primary.label}
          </button>
        )}
      </div>
    </GlassDialog>
  );
}
