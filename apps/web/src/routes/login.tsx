import { useState, type FormEvent, type JSX } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ApiError } from "@hydra/client-core";
import { LoginForm } from "@hydra/contract";
import { Button, Input } from "@hydra/ui";
import { validate, type FieldErrors } from "../app/form";
import { HOME_PATH } from "../app/entry-guard";
import { CenteredScreen, Field } from "./-centered-screen";

/** One message for both halves, so the form never says which one was right. */
const REJECTED = "Wrong username or password.";

export const Route = createFileRoute("/login")({
  staticData: { title: "Sign in" },
  component: Login,
});

function Login(): JSX.Element {
  const { client, queryClient } = Route.useRouteContext();
  const navigate = useNavigate();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setFailure(null);

    const checked = validate(LoginForm, { username, password });
    setErrors(checked.errors ?? {});
    if (checked.errors !== undefined) return;

    setSubmitting(true);
    try {
      await client.auth.login({ payload: checked.value });
    } catch (error) {
      setFailure(
        error instanceof ApiError && error.code === "unauthenticated"
          ? REJECTED
          : error instanceof Error
            ? error.message
            : String(error),
      );
      setSubmitting(false);
      return;
    }

    // Everything read before the sign-in was read as somebody else.
    queryClient.clear();
    await navigate({ to: HOME_PATH });
  };

  return (
    <CenteredScreen title="Sign in">
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
            autoComplete="current-password"
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
          Sign in
        </Button>
      </form>
    </CenteredScreen>
  );
}
