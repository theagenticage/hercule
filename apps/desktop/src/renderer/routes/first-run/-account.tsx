import { useState, type JSX } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  ApiError,
  completeSetup,
  listTimezoneChoices,
  ONBOARDING_STEPS,
  readErrorMessage,
  resolveBrowserTimezone,
  validatePasswordLength,
  type HerculeClient,
} from "@hercule/client-core";
import type { FirstRunProgress } from "../../../ipc/contract";
import {
  ensureFirstRunData,
  firstRunQuery,
  macUserQuery,
  setupQuery,
  setupTokenQuery,
} from "../../app/queries";
import { AccountStep, type AccountError, type AccountForm } from "../../screens/first-run";

/** The line for a setup token the controller refused, which Create account then reads again. */
const TOKEN_REFUSED =
  "Hercule refused the setup token, which may be out of date. Create account tries again with a new one.";

/**
 * Renders the account step, which sets Hercule up with the user's account.
 *
 * Create account runs, in this order:
 *
 * 1. `setup.complete`, with the setup token main hands over. The client
 *    keeps the login token from the reply, so the user is signed in.
 * 2. `firstRunProgress.save`, which records in main that a first run is in
 *    progress, so a relaunch resumes it. It comes straight after setup: a set-up controller
 *    with no first-run record sends a relaunch home, past every later step.
 * 3. `settings.update`, which marks the web app's onboarding steps done, so
 *    the web app never asks for them again. When a quit or a relaunch comes
 *    between steps 2 and 3, All set marks them before the first run ends.
 *
 * Then it reads everything the next steps show, and only then marks setup
 * complete in the cache and calls `onSignedIn`, which moves the first run on
 * to the next step with nothing left to wait for.
 *
 * When a write after `setup.complete` fails, the error shows and Create
 * account tries again. The controller refuses a second `setup.complete`, so
 * each try first asks the controller whether setup already went through.
 * It asks the controller rather than the cache: the cache holds setup as
 * complete only once every read is done, because that moves the first run on.
 */
export function AccountCard({
  client,
  onSignedIn,
}: {
  readonly client: HerculeClient;
  readonly onSignedIn: () => void;
}): JSX.Element {
  const { bridge } = useRouteContext({ from: "__root__" });
  const queryClient = useQueryClient();
  const { username } = useSuspenseQuery(macUserQuery(bridge)).data;
  const [form, setForm] = useState<AccountForm>(() => ({
    username,
    password: "",
    timezone: resolveBrowserTimezone(),
  }));
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const createAccount = useMutation({
    mutationFn: async (values: AccountForm) => {
      if (!(await client.setup.read()).complete) {
        const setupToken = await queryClient.fetchQuery(setupTokenQuery(bridge));
        // Main has no token: the first run shows the remote screen, which
        // asks for the setup address, as soon as the cache holds this answer.
        if (setupToken._tag === "PasteNeeded") throw new Error("Paste the setup address.");
        await completeSetup(client, setupToken.token, values);
      }
      const progress: FirstRunProgress = { putOff: [] };
      await bridge.firstRunProgress.save(progress);
      queryClient.setQueryData(firstRunQuery(bridge).queryKey, progress);
      await client.settings.update({
        payload: { user: { "onboarding.completedSteps": [...ONBOARDING_STEPS] } },
      });
      await ensureFirstRunData(queryClient, client, bridge);
    },
    onSuccess: () => {
      queryClient.setQueryData(setupQuery(client).queryKey, { complete: true });
      onSignedIn();
    },
    onError: (error) => {
      // Each start of Hercule mints a new token, so the one main handed over
      // can be out of date. The next Create account reads it again.
      if (isTokenRefusal(error)) {
        void queryClient.invalidateQueries({ queryKey: setupTokenQuery(bridge).queryKey });
      }
    },
  });

  let error: AccountError | null = null;
  if (passwordError !== null) error = { field: "password", message: passwordError };
  else if (createAccount.isError) {
    error = {
      field: null,
      message: isTokenRefusal(createAccount.error)
        ? TOKEN_REFUSED
        : readErrorMessage(createAccount.error),
    };
  }

  return (
    <AccountStep
      form={form}
      timezones={listTimezoneChoices(form.timezone)}
      error={error}
      submitting={createAccount.isPending}
      onChange={(next) => {
        setForm(next);
        if (next.password !== form.password) setPasswordError(null);
      }}
      onSubmit={() => {
        const invalid = validatePasswordLength(form.password);
        setPasswordError(invalid);
        if (invalid === null) createAccount.mutate({ ...form, username: form.username.trim() });
      }}
    />
  );
}

/** Checks whether `error` is the controller refusing the setup token. */
const isTokenRefusal = (error: unknown): boolean =>
  error instanceof ApiError && error.code === "unauthenticated";
