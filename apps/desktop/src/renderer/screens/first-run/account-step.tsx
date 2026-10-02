/**
 * The first run's account step: the form that sets Hercule up with the
 * user's account. Presentational.
 */
import { useState, type FormEvent, type JSX } from "react";
import { MIN_PASSWORD_LENGTH } from "@hercule/contract";
import { buildLook, Face } from "../../faces";
import { ClockIcon, QuestionIcon } from "../../icons";
import { FormField, Warning } from "../step";
import { StepKicker } from "./first-run-frame";

/** The values the account form holds. */
export interface AccountForm {
  readonly username: string;
  readonly password: string;
  readonly timezone: string;
}

/**
 * Why the last Create account did not go through. An error about the
 * password (`field: "password"`) is drawn under the password; any other is
 * drawn as a warning over the button.
 */
export interface AccountError {
  readonly field: "password" | null;
  readonly message: string;
}

/**
 * Renders the account step with `form`'s values. `timezones` are the zones
 * the Change link offers. `error` is why the last Create account failed, or
 * null. While `submitting`, Create account is busy. `onSubmit` runs on
 * Create account, and `onChange` on every edit, with the form as it now is.
 */
export function AccountStep({
  form,
  timezones,
  error,
  submitting,
  onChange,
  onSubmit,
}: {
  readonly form: AccountForm;
  readonly timezones: readonly string[];
  readonly error: AccountError | null;
  readonly submitting: boolean;
  readonly onChange: (form: AccountForm) => void;
  readonly onSubmit: () => void;
}): JSX.Element {
  // Whether the user opened the timezone picker. Only this screen needs it.
  const [choosingTimezone, setChoosingTimezone] = useState(false);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!submitting) onSubmit();
  };
  return (
    <form onSubmit={submit}>
      <StepKicker step="account" />
      <h1 className="st-h">Create your account</h1>
      <p className="st-sub">
        You sign in with it here, on the web and in the terminal. Everything Hercule does is signed
        with who did it: you, or one of your agents.
      </p>
      <div className="st-form">
        <FormField label="Username" hint="Your Mac’s account name. Change it if you like.">
          <input
            value={form.username}
            onChange={(event) => onChange({ ...form, username: event.target.value })}
            spellCheck={false}
            autoComplete="username"
            autoCapitalize="off"
          />
        </FormField>
        <FormField
          label="Password"
          error={error?.field === "password" ? error.message : null}
          hint={`At least ${String(MIN_PASSWORD_LENGTH)} characters.`}
        >
          <input
            type="password"
            value={form.password}
            onChange={(event) => onChange({ ...form, password: event.target.value })}
            autoComplete="new-password"
            autoFocus
          />
        </FormField>
        {choosingTimezone ? (
          <FormField label="Timezone">
            <select
              value={form.timezone}
              onChange={(event) => onChange({ ...form, timezone: event.target.value })}
            >
              {timezones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
          </FormField>
        ) : (
          <div className="row fine">
            <ClockIcon size={14} />
            <span>
              Times show in <b className="tz">{form.timezone}</b>
            </span>
            <button type="button" className="link" onClick={() => setChoosingTimezone(true)}>
              Change
            </button>
          </div>
        )}
      </div>
      {error === null || error.field !== null ? null : (
        <Warning icon={<QuestionIcon size={14} />}>{error.message}</Warning>
      )}
      <div className="st-actions">
        <button
          type="submit"
          className="btn btn--accent btn--lg"
          aria-busy={submitting ? true : undefined}
        >
          {submitting ? (
            <>
              <span className="spin" />
              Creating your account…
            </>
          ) : (
            "Create account"
          )}
        </button>
      </div>
      <p className="st-note">
        <Face look={buildLook("Hercule")} pose="asleep" size={18} />
        <span>
          This also sets up <b>Hercule, your assistant</b>. Give it a chat channel later in the web
          app’s Settings › Assistants.
        </span>
      </p>
    </form>
  );
}
