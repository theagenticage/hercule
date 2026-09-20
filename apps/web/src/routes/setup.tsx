import { useState, type FormEvent, type JSX } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { browserTimezone } from "@hercule/client-core";
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
            "`hercule serve` printed a setup URL in the terminal. It carries the one-time token this "
          }
          {"screen needs, so this is where you have to arrive from."}
        </p>
      </CenteredScreen>
    );
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setFailure(null);

    // The timezone is never asked for here: the controller needs one from its
    // first minute, and the browser already knows it.
    const checked = validate(SetupForm, { username, password, timezone: browserTimezone() });
    setErrors(checked.errors ?? {});
    if (checked.errors !== undefined) return;

    setSubmitting(true);
    // The setup token is presented the way every other credential is, as the
    // client's bearer, but it is never written where it would outlive the call:
    // it is spent by the answer, and a tab closed mid-flight must leave no
    // credential behind. A successful call replaces it with the login token.
    client.presentToken(token);
    try {
      await client.setup.complete({ payload: checked.value });
    } catch (error) {
      client.presentToken(null);
      setFailure(error instanceof Error ? error.message : String(error));
      setSubmitting(false);
      return;
    }

    // First run has happened and there is a user now, so nothing read before
    // this point still holds.
    queryClient.clear();
    // The one-time token has been spent. Replacing the entry that carried it
    // takes it out of the address bar and out of the back button at once; the
    // entry guard sends the replacement on to the first onboarding step.
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
