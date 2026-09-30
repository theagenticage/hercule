import type { JSX, ReactNode } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Button, EmptyState } from "@hercule/ui";
import { queryKeys, decideSessionsEmptyState, readErrorMessage } from "@hercule/client-core";
import { useLiveInvalidation } from "../../app/live-invalidation";
import { localRunnerQuery, providersQuery, runnersQuery } from "../../app/queries";
import { CreateThreadLink } from "../../screens/create-thread-link";
import { ProviderKeyEntry, ProviderLogin } from "../../screens/provider-login";

export const Route = createFileRoute("/_shell/")({
  staticData: { title: "Sessions" },
  // Wait for local runner detection. Otherwise "No runner has been detected"
  // could flash up and send the user off to start a runner they already have.
  loader: async ({ context }) => {
    const [runners] = await Promise.all([
      context.queryClient.ensureQueryData(runnersQuery(context.client)),
      context.queryClient.ensureQueryData(providersQuery(context.client)),
    ]);
    await context.queryClient.ensureQueryData(
      localRunnerQuery(context.detectLocalRunner, runners.items),
    );
  },
  component: Sessions,
});

/**
 * The home screen, which also finishes onboarding: it tells the user what to
 * do next. Until a logged-in harness is ready, the Create new thread button is
 * shown disabled, with the reason above it, rather than hidden.
 */
function Sessions(): JSX.Element {
  const { client, queryClient, live, detectLocalRunner } = Route.useRouteContext();

  useLiveInvalidation(live, queryClient, "runner");
  useLiveInvalidation(live, queryClient, "provider");

  const runners = useSuspenseQuery(runnersQuery(client)).data.items;
  const instances = useSuspenseQuery(providersQuery(client)).data;
  const localId = useQuery(localRunnerQuery(detectLocalRunner, runners)).data ?? null;
  const local = runners.find((runner) => runner.id === localId) ?? null;

  const state = decideSessionsEmptyState(local, instances);
  const reread = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.providers() });
  };
  // A login writes a credential that the stored provider snapshot does not
  // know about, so ask the machine to probe the instance again before this
  // screen treats it as logged in.
  const probe = useMutation({
    mutationFn: (asked: { readonly runnerId: string; readonly instanceId: string }) =>
      client.runner.probe({
        params: { id: asked.runnerId },
        payload: { instanceId: asked.instanceId },
      }),
    onSuccess: reread,
  });

  // The state alone already covers `local === null`; the check is here so
  // TypeScript narrows `local` for the code below.
  if (local === null || state.kind === "no-runner") {
    return (
      <Screen
        headline="No runner has been detected on this machine."
        lead="A thread runs on a machine. Start a runner here and Hercule will look for the harnesses installed on it - Claude Code, Codex, pi - and offer to log in to them."
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
        lead="A thread runs on a coding harness - Claude Code, Codex or pi. Install one on this machine and Hercule will offer to log in to it."
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
        headline={describeFoundHarnesses(state.offers.map((row) => row.name))}
        lead={state.lead}
        fine="A thread needs a harness that is logged in, so starting one waits on this."
        failure={probe.error === null ? null : readErrorMessage(probe.error)}
      >
        {state.offers.flatMap((row) => {
          const probeOfferedInstance = () => {
            probe.mutate({ runnerId: local.id, instanceId: row.id });
          };
          // A provider that authenticates with a value the user supplies, such
          // as an API key, has no vendor login page, so ask for the value here.
          return row.secretFields.length === 0
            ? [
                <ProviderLogin
                  key={row.id}
                  client={client}
                  instanceId={row.id}
                  runnerId={local.id}
                  subject={`${row.name} on this machine`}
                  label={`Log in to ${row.name}`}
                  variant="primary"
                  onLoggedIn={probeOfferedInstance}
                />,
              ]
            : row.secretFields.map((field) => (
                <ProviderKeyEntry
                  key={`${row.id}:${field.name}`}
                  client={client}
                  instanceId={row.id}
                  field={field}
                  variant="primary"
                  onSaved={probeOfferedInstance}
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
