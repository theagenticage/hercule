import { useState, type FormEvent, type JSX } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { readErrorMessage, resolveBrowserTimezone } from "@hercule/client-core";
import { SetupForm } from "@hercule/contract";
import { Button, Field, Input } from "@hercule/ui";
import { validate, type FieldErrors } from "../app/form";
import { SETUP_PATH } from "../app/entry-guard";
import { CenteredScreen } from "../screens/centered-screen";

export const Route = createFileRoute("/setup")({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === "string" ? search.token : undefined,
  }),
  staticData: { title: "Create your account" },
  component: Setup,
});

function Setup(): JSX.Element {
  const { token } = Route.useSearch();
  const { client, queryClient } = Route.useRouteContext();
  const navigate = useNavigate();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (token === undefined) {
    return (
      <CenteredScreen title="Open the setup link">
        <p className="text-meta text-muted">
          {
            "`hercule serve` printed a setup URL in the terminal. It contains the one-time token this "
          }
          {"screen needs, so open that URL to continue."}
        </p>
      </CenteredScreen>
    );
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setFailure(null);

    // The form does not ask for a timezone: the controller needs one from the
    // start, and the browser already knows it.
    const checked = validate(SetupForm, { username, password, timezone: resolveBrowserTimezone() });
    setErrors(checked.errors ?? {});
    if (checked.errors !== undefined) return;

    setSubmitting(true);
    // Send the setup token as the client's bearer token, like any other
    // credential, but never store it: the call uses it up, and a tab closed
    // during the call must leave no credential behind. A successful call
    // replaces it with the login token.
    client.presentToken(token);
    try {
      await client.setup.complete({ payload: checked.value });
    } catch (error) {
      client.presentToken(null);
      setFailure(readErrorMessage(error));
      setSubmitting(false);
      return;
    }

    // First run is complete and a user exists now, so everything cached before
    // this point is out of date.
    queryClient.clear();
    // The one-time token is used up. Replacing the history entry that holds it
    // removes it from both the address bar and the back button. The entry
    // guard then redirects to the first onboarding step.
    await navigate({ to: SETUP_PATH, search: { token: undefined }, replace: true });
  };

  return (
    <CenteredScreen
      title="Create your account"
      lead="This is the account you will sign in to Hercule with."
    >
      <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
        <Field id="username" label="Username" error={errors.username}>
          <Input
            id="username"
            name="username"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={(event) => {
              setUsername(event.target.value);
            }}
          />
        </Field>
        <Field id="password" label="Password" error={errors.password}>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
        </Field>
        {failure === null ? null : (
          <p className="text-fine text-fail" role="alert">
            {failure}
          </p>
        )}
        <Button
          type="submit"
          variant="form"
          disabled={submitting}
          className="mt-2 w-full justify-center py-2"
        >
          Create account
        </Button>
      </form>
    </CenteredScreen>
  );
}
