import type { JSX } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, FormCard } from "@hercule/ui";
import {
  buildProviderRows,
  queryKeys,
  type HerculeClient,
  type ProviderRow,
  readErrorMessage,
} from "@hercule/client-core";
import type { RunnerDetail } from "@hercule/contract";
import { ProviderKeyEntry, ProviderLogin } from "../../../screens/provider-login";
import { providersQuery } from "../../../app/queries";

/**
 * The Providers card on the runner page: one row per provider instance, with
 * its install, log-in and probe actions. An install the machine cannot do is
 * shown disabled, with the reason on the row, rather than hidden.
 */
export function Providers({
  client,
  runner,
}: {
  readonly client: HerculeClient;
  readonly runner: RunnerDetail;
}): JSX.Element | null {
  const queryClient = useQueryClient();
  const instances = useQuery(providersQuery(client));

  const reread = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.providers() });
  };

  const probe = useMutation({
    mutationFn: (instanceId: string) =>
      client.runner.probe({ params: { id: runner.id }, payload: { instanceId } }),
    onSuccess: reread,
  });
  const install = useMutation({
    mutationFn: (providerId: string) =>
      client.runner.installHarness({ params: { id: runner.id }, payload: { providerId } }),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.runner(runner.id), updated);
      reread();
    },
  });

  if (instances.error !== null) {
    return (
      <FormCard label="Providers">
        <p className="text-fine text-fail" role="alert">
          {readErrorMessage(instances.error)}
        </p>
      </FormCard>
    );
  }
  if (instances.data === undefined) return null;
  const rows = buildProviderRows(runner, instances.data);

  return (
    <FormCard label="Providers">
      <div className="flex flex-col gap-3.5">
        {rows.map((row, index) => (
          <Row
            key={row.id}
            row={row}
            client={client}
            runnerId={runner.id}
            runnerName={runner.name}
            first={index === 0}
            busy={probe.isPending || install.isPending}
            onProbe={() => {
              probe.mutate(row.id);
            }}
            onInstall={() => {
              install.mutate(row.providerId);
            }}
            // The stored snapshot does not know about the new credential yet, so
            // the machine is probed again rather than the page refetching the
            // same stale snapshot.
            onCredentialEntered={() => {
              probe.mutate(row.id);
            }}
          />
        ))}
      </div>
      {probe.error === null && install.error === null ? null : (
        <p className="text-fine text-fail" role="alert">
          {readErrorMessage(probe.error ?? install.error)}
        </p>
      )}
    </FormCard>
  );
}

function Row({
  row,
  client,
  runnerId,
  runnerName,
  first,
  busy,
  onProbe,
  onInstall,
  onCredentialEntered,
}: {
  readonly row: ProviderRow;
  readonly client: HerculeClient;
  readonly runnerId: string;
  readonly runnerName: string;
  readonly first: boolean;
  readonly busy: boolean;
  readonly onProbe: () => void;
  readonly onInstall: () => void;
  readonly onCredentialEntered: () => void;
}): JSX.Element {
  return (
    // Grouped so a screen reader reads one provider's facts and actions as
    // one unit.
    <div
      role="group"
      aria-label={row.name}
      className={
        first ? "flex flex-col gap-1" : "flex flex-col gap-1 border-t border-line-soft pt-3"
      }
    >
      <div className="flex items-baseline gap-2.5 text-row">
        <b className="min-w-0 truncate font-emph text-ink">{row.name}</b>
        <span className="font-mono text-fine text-muted">{row.version}</span>
        {row.verdict === null ? null : (
          <span className="rounded-control bg-attn-soft px-1.5 text-fine text-attn">
            {row.verdict}
          </span>
        )}
      </div>
      <div className="text-row text-muted">
        {row.account} <span className="text-faint">· {row.models}</span>
      </div>
      <div className="-ml-2 flex flex-wrap items-center gap-1.5">
        {row.install === "none" ? null : (
          <Button disabled={row.install === "blocked" || busy} onClick={onInstall}>
            Install
          </Button>
        )}
        {row.logIn ? (
          <ProviderLogin
            client={client}
            instanceId={row.id}
            runnerId={runnerId}
            subject={`${row.name} on ${runnerName}`}
            label={row.logInLabel}
            onLoggedIn={onCredentialEntered}
          />
        ) : null}
        {row.secretFields.map((field) => (
          <ProviderKeyEntry
            key={`${row.id}:${field.name}`}
            client={client}
            instanceId={row.id}
            field={field}
            onSaved={onCredentialEntered}
          />
        ))}
        {row.probe ? (
          <Button disabled={busy} onClick={onProbe}>
            Probe now
          </Button>
        ) : null}
      </div>
    </div>
  );
}
