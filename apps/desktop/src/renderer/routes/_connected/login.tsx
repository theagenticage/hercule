import { useState, type JSX } from "react";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { ApiError, isMutationRunning } from "@hercule/client-core";
import { CONNECT_PATH } from "../../app/entry-guard";
import { openLaunchScreen } from "../../app/last-screen";
import { CenteredFooter, CenteredScreen } from "../../screens/centered-screen";

export const Route = createFileRoute("/_connected/login")({
  // The app can start on this route, so it is not split into a chunk of its
  // own: a split route costs two more requests (its script and its
  // stylesheet) before the first render.
  codeSplitGroupings: [],
  staticData: { title: "Sign in" },
  component: SignIn,
});

/** Names the sign-in in the query client's mutation cache, where the submit handler looks for it. */
const SIGN_IN_KEY = ["auth.login"];

/**
 * Returns the line that explains why signing in failed. A wrong username and
 * a wrong password get one message, so the form never reveals which one was
 * right. Any other failure shows its own message, which for a
 * `ConnectionError` says whether the app could not connect to the controller
 * or the controller did not answer in time.
 */
const describeSignInFailure = (error: Error): string =>
  error instanceof ApiError && error.code === "unauthenticated"
    ? "Wrong username or password."
    : error.message;

function SignIn(): JSX.Element {
  const { controller, queryClient, appearance } = Route.useRouteContext();
  const navigate = useNavigate();
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const signIn = useMutation({
    mutationKey: SIGN_IN_KEY,
    mutationFn: () => controller.client.auth.login({ payload: { username, password } }),
    onSuccess: () => {
      openLaunchScreen(router, controller.url, appearance.read().openOn);
    },
  });

  return (
    <CenteredScreen>
      <form
        className="centered-form"
        onSubmit={(event) => {
          event.preventDefault();
          // Sign in stays enabled while the controller checks the password,
          // so that it keeps focus, and a second press must do nothing.
          if (isMutationRunning(queryClient, SIGN_IN_KEY)) return;
          signIn.mutate();
        }}
      >
        <input
          className="field"
          type="text"
          name="username"
          autoComplete="username"
          aria-label="Username"
          placeholder="Username"
          spellCheck={false}
          autoCapitalize="off"
          autoFocus
          value={username}
          onChange={(event) => {
            setUsername(event.target.value);
          }}
        />
        <input
          className="field"
          type="password"
          name="password"
          autoComplete="current-password"
          aria-label="Password"
          placeholder="Password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />
        {signIn.isError ? (
          <p className="centered-error" role="alert">
            {describeSignInFailure(signIn.error)}
          </p>
        ) : null}
        <button
          type="submit"
          className="btn btn--accent"
          disabled={username === "" || password === ""}
          aria-disabled={signIn.isPending || undefined}
        >
          {signIn.isPending ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <CenteredFooter
        text={`Connected to ${controller.url}`}
        onChange={() => {
          void navigate({ to: CONNECT_PATH });
        }}
      />
    </CenteredScreen>
  );
}
