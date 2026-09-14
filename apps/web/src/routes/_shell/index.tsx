import type { JSX, ReactNode } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Button, EmptyState } from "@hydra/ui";
import { queryKeys, sessionsEmptyState } from "@hydra/client-core";
import { useLiveInvalidation } from "../../app/live-invalidation";
import { localRunnerQuery, providersQuery, runnersQuery } from "../../app/queries";
import { CreateThreadLink } from "../../screens/create-thread-link";
import { ProviderLogin } from "../../screens/provider-login";
import { messageOf } from "../../screens/save-status";

export const Route = createFileRoute("/_shell/")({
  staticData: { title: "Sessions" },
  // Detection is awaited: a flash of "no runner has been detected" would send
  // the reader off to start one they already have.
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
 * The home screen, and the rest of onboarding: what it says is what the user
 * does next. Nothing starts a thread yet, so the button that would is disabled
 * with its reason rather than hidden.
 */
function Sessions(): JSX.Element {
  const { client, queryClient, live, detectLocalRunner } = Route.useRouteContext();

  useLiveInvalidation(live, queryClient, "runner");
  useLiveInvalidation(live, queryClient, "provider");

  const runners = useSuspenseQuery(runnersQuery(client)).data.items;
  const instances = useSuspenseQuery(providersQuery(client)).data;
  const localId = useQuery(localRunnerQuery(detectLocalRunner, runners)).data ?? null;
  const local = runners.find((runner) => runner.id === localId) ?? null;

  const state = sessionsEmptyState(local, instances);
  const reread = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.providers() });
  };
  // A login writes a credential the stored snapshot knows nothing about, so the
  // machine is asked about the instance again before this screen believes it.
  const probe = useMutation({
    mutationFn: (asked: { readonly runnerId: string; readonly instanceId: string }) =>
      client.runner.probe({
        params: { id: asked.runnerId },
        payload: { instanceId: asked.instanceId },
      }),
    onSuccess: reread,
  });

  // `local === null` is what narrows the type below; the state alone already
  // says so.
  if (local === null || state.kind === "no-runner") {
    return (
      <Screen
        headline="No runner has been detected on this machine."
        lead="A thread runs on a machine. Start a runner here and Hydra will look for the harnesses installed on it - Claude Code, Codex, pi - and offer to log in to them."
        fine={
          <>
            Run{" "}
            <code className="rounded-[4px] bg-line-soft px-1.5 py-px font-mono text-fine">
              hydra runner
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
        lead="A thread runs on a coding harness - Claude Code, Codex or pi. Install one on this machine and Hydra will offer to log in to it."
        fine={
          <Link to="/fleet/$runnerId" params={{ runnerId: local.id }} className="underline">
            Install one from Fleet
          </Link>
        }
      />
    );
  }

  if (state.kind === "log-in") {
    return (
      <Screen
        headline={found(state.instances.map((instance) => instance.displayName))}
        lead="Log in to use it in Hydra. The login runs on this machine and its credential stays there."
        fine="A thread needs a harness that is logged in, so starting one waits on this."
        failure={probe.error === null ? null : messageOf(probe.error)}
      >
        {state.instances.map((instance) => (
          <ProviderLogin
            key={instance.id}
            client={client}
            instanceId={instance.id}
            runnerId={local.id}
            subject={`${instance.displayName} on this machine`}
            label={`Log in to ${instance.displayName}`}
            variant="primary"
            onLoggedIn={() => {
              probe.mutate({ runnerId: local.id, instanceId: instance.id });
            }}
          />
        ))}
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
  /** What the last move on this screen failed with, if it failed. */
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

/** The harnesses on offer, read as a sentence rather than as a list. */
const found = (names: ReadonlyArray<string>): string =>
  names.length < 2
    ? `${names[0] ?? "A coding harness"} was found on this machine.`
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] ?? ""} were found on this machine.`;
