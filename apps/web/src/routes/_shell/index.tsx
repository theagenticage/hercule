import type { JSX, ReactNode } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Button, EmptyState } from "@hercule/ui";
import { queryKeys, decideSessionsEmptyState, readErrorMessage } from "@hercule/client-core";
import { useLiveInvalidation } from "../../app/live-invalidation";
import {
  ensureAccountReads,
  harnessesQuery,
  localRunnerQuery,
  providerAccountsQuery,
  providersQuery,
  runnersQuery,
} from "../../app/queries";
import { CreateThreadLink } from "../../screens/create-thread-link";
import { ProviderKeyEntry, ProviderLogin } from "../../screens/provider-login";

export const Route = createFileRoute("/_shell/")({
  staticData: { title: "Sessions" },
  // Wait for local runner detection. Otherwise "No runner has been detected"
  // could flash up and send the user off to start a runner they already have.
  loader: async ({ context }) => {
    const [runners] = await Promise.all([
      context.queryClient.ensureQueryData(runnersQuery(context.client)),
      ensureAccountReads(context.queryClient, context.client),
    ]);
    await context.queryClient.ensureQueryData(
      localRunnerQuery(context.detectLocalRunner, runners.items),
    );
  },
  component: Sessions,
});

/**
 * The home screen, which also finishes onboarding: it tells the user what to
 * do next. Until a signed-in account is ready, the Create new thread button is
 * shown disabled, with the reason above it, rather than hidden.
 */
function Sessions(): JSX.Element {
  const { client, queryClient, live, detectLocalRunner } = Route.useRouteContext();

  useLiveInvalidation(live, queryClient, "runner");
  useLiveInvalidation(live, queryClient, "provider");

  const runners = useSuspenseQuery(runnersQuery(client)).data.items;
  const accounts = useSuspenseQuery(providerAccountsQuery(client)).data;
  const providers = useSuspenseQuery(providersQuery(client)).data;
  const harnesses = useSuspenseQuery(harnessesQuery(client)).data;
  const localId = useQuery(localRunnerQuery(detectLocalRunner, runners)).data ?? null;
  const local = runners.find((runner) => runner.id === localId) ?? null;

  const state = decideSessionsEmptyState(local, accounts, providers, harnesses);
  const reread = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.providerAccounts() });
  };
  // A sign-in writes a credential that the stored account snapshot does not
  // know about, so ask the machine to probe the account again before this
  // screen treats it as signed in.
  const probe = useMutation({
    mutationFn: (asked: { readonly runnerId: string; readonly providerAccountId: string }) =>
      client.runner.probe({
        params: { id: asked.runnerId },
        payload: { providerAccountId: asked.providerAccountId },
      }),
    onSuccess: reread,
  });

  // The state alone already covers `local === null`; the check is here so
  // TypeScript narrows `local` for the code below.
  if (local === null || state.kind === "no-runner") {
    return (
      <Screen
        headline="No runner has been detected on this machine."
        lead="A thread runs on a machine. Start a runner here and Hercule will look for the harnesses installed on it - Claude Code, Codex, pi - and offer to sign in to them."
        fine={
          <>
            Run{" "}
            <code className="rounded-[4px] bg-line-soft px-1.5 py-px font-mono text-fine">
              hercule runner
            </code>{" "}
            on this machine, or join another one from Fleet.
          </>
        }
      />
    );
  }

  if (state.kind === "no-harness") {
    return (
      <Screen
        headline="No coding harness was found on this machine."
        lead="A thread runs on a coding harness - Claude Code, Codex or pi. Install one on this machine and Hercule will offer to sign in to it."
        fine={
          <Link to="/fleet/$runnerId" params={{ runnerId: local.id }} className="underline">
            Install one from Fleet
          </Link>
        }
      />
    );
  }

  if (state.kind === "sign-in") {
    return (
      <Screen
        headline={describeFoundHarnesses(state.offers.map((row) => row.harnessName))}
        lead={state.lead}
        fine={
          <>
            A thread needs an account that is signed in, so starting one waits on this. Small
            background tasks like naming a thread use a text generation model - change it in{" "}
            <Link to="/settings/system" className="underline">
              Settings &gt; System
            </Link>
            .
          </>
        }
        failure={probe.error === null ? null : readErrorMessage(probe.error)}
      >
        {state.offers.flatMap((row) => {
          const probeOfferedAccount = () => {
            probe.mutate({ runnerId: local.id, providerAccountId: row.id });
          };
          // An account that authenticates with a value the user supplies, such
          // as an API key, has no vendor login page, so ask for the value here.
          return row.credentialFields.length === 0
            ? [
                <ProviderLogin
                  key={row.id}
                  client={client}
                  live={live}
                  providerAccountId={row.id}
                  runnerId={local.id}
                  subject={`${row.name} on this machine`}
                  label={`Sign in to ${row.name}`}
                  variant="primary"
                  onSignedIn={probeOfferedAccount}
                />,
              ]
            : row.credentialFields.map((field) => (
                <ProviderKeyEntry
                  key={`${row.id}:${field.name}`}
                  client={client}
                  providerAccountId={row.id}
                  field={field}
                  variant="primary"
                />
              ));
        })}
      </Screen>
    );
  }

  return (
    <Screen
      headline={`${state.name} is ready.`}
      lead="Create a thread and type a prompt to get started."
      ready
    />
  );
}

function Screen({
  headline,
  lead,
  fine,
  ready = false,
  failure = null,
  children,
}: {
  readonly headline: string;
  readonly lead: string;
  readonly fine?: ReactNode;
  /** Whether a thread can actually be started from here yet. */
  readonly ready?: boolean;
  /** The error message of the last action on this screen, if it failed. */
  readonly failure?: string | null;
  readonly children?: ReactNode;
}): JSX.Element {
  return (
    <EmptyState headline={headline} lead={lead} fine={fine}>
      <div className="-ml-2 flex flex-wrap items-center gap-0.5">
        {children}
        {ready ? (
          <CreateThreadLink />
        ) : (
          <Button variant="primary" disabled>
            Create new thread
          </Button>
        )}
      </div>
      {failure === null ? null : (
        <p className="text-fine text-fail" role="alert">
          {failure}
        </p>
      )}
    </EmptyState>
  );
}

/** Returns a headline sentence naming the harnesses found, such as "Claude Code and Codex were found on this machine." */
const describeFoundHarnesses = (names: ReadonlyArray<string>): string =>
  names.length < 2
    ? `${names[0] ?? "A coding harness"} was found on this machine.`
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] ?? ""} were found on this machine.`;
