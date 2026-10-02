import { useRef, useState, type JSX } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  ApiError,
  completeSetup,
  listSupportedTimezones,
  ONBOARDING_STEPS,
  readErrorMessage,
  resolveBrowserTimezone,
  type HerculeClient,
} from "@hercule/client-core";
import { MIN_PASSWORD_LENGTH } from "@hercule/contract";
import type { FirstRunProgress } from "../../../ipc/contract";
import {
  ensureFirstRunData,
  firstRunQuery,
  macUserQuery,
  setupQuery,
  setupTokenQuery,
} from "../../app/queries";
import { AccountStep, type AccountError, type AccountForm } from "../../screens/first-run";

/** The password's error when it is shorter than the contract allows. */
const TOO_SHORT = `Use at least ${String(MIN_PASSWORD_LENGTH)} characters.`;

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
 * 2. `settings.update`, which marks the web app's onboarding steps done, so
 *    the web app never asks for them again.
 * 3. `firstRun.write`, which tells main a first run is in progress, so a
 *    relaunch resumes it.
 *
 * Then it reads everything the next steps show, and only then marks setup
 * complete in the cache, which moves the first run on to the next step with
 * nothing left to wait for.
 */
export function AccountCard({ client }: { readonly client: HerculeClient }): JSX.Element {
  const { bridge } = useRouteContext({ from: "__root__" });
  const queryClient = useQueryClient();
  const { username } = useSuspenseQuery(macUserQuery(bridge)).data;
  const [form, setForm] = useState<AccountForm>(() => ({
    username,
    password: "",
    timezone: resolveBrowserTimezone(),
  }));
  const [tooShort, setTooShort] = useState(false);
  // Whether `setup.complete` went through. A later write can still fail, and
  // its retry must not run setup again: the controller refuses that, because
  // it is set up.
  const setUp = useRef(false);

  const create = useMutation({
    mutationFn: async (values: AccountForm) => {
      if (!setUp.current) {
        const setupToken = await queryClient.fetchQuery(setupTokenQuery(bridge));
        // Main has no token: the first run shows the remote screen, which
        // asks for the setup address, as soon as the cache holds this answer.
        if (setupToken._tag === "PasteNeeded") throw new Error("Paste the setup address.");
        await completeSetup(client, setupToken.token, values);
        setUp.current = true;
      }
      await client.settings.update({
        payload: { user: { "onboarding.completedSteps": [...ONBOARDING_STEPS] } },
      });
      const progress: FirstRunProgress = { putOff: [] };
      await bridge.firstRun.write(progress);
      queryClient.setQueryData(firstRunQuery(bridge).queryKey, progress);
      await ensureFirstRunData(queryClient, client, bridge);
    },
    onSuccess: () => {
      queryClient.setQueryData(setupQuery(client).queryKey, { complete: true });
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
  if (tooShort) error = { field: "password", message: TOO_SHORT };
  else if (create.isError) {
    error = {
      field: null,
      message: isTokenRefusal(create.error) ? TOKEN_REFUSED : readErrorMessage(create.error),
    };
  }

  return (
    <AccountStep
      form={form}
      timezones={listSupportedTimezones()}
      error={error}
      submitting={create.isPending}
      onChange={(next) => {
        setForm(next);
        if (next.password !== form.password) setTooShort(false);
      }}
      onSubmit={() => {
        const short = form.password.length < MIN_PASSWORD_LENGTH;
        setTooShort(short);
        if (!short) create.mutate({ ...form, username: form.username.trim() });
      }}
    />
  );
}

/** Checks whether `error` is the controller refusing the setup token. */
const isTokenRefusal = (error: unknown): boolean =>
  error instanceof ApiError && error.code === "unauthenticated";
