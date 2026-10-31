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
import { harnessesQuery, providerAccountsQuery, providersQuery } from "../../../app/queries";

/**
 * The Providers card on the runner page: one row per Provider Account, with
 * its install, sign-in and probe actions. An install the machine cannot do is
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
  const accounts = useQuery(providerAccountsQuery(client));
  const providers = useQuery(providersQuery(client));
  const harnesses = useQuery(harnessesQuery(client));

  const reread = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.providerAccounts() });
  };

  const probe = useMutation({
    mutationFn: (providerAccountId: string) =>
      client.runner.probe({ params: { id: runner.id }, payload: { providerAccountId } }),
    onSuccess: reread,
  });
  const install = useMutation({
    mutationFn: (harnessId: string) =>
      client.runner.installHarness({ params: { id: runner.id }, payload: { harnessId } }),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.runner(runner.id), updated);
      // A new install changes which runners have the harness.
      void queryClient.invalidateQueries({ queryKey: queryKeys.harnesses() });
      reread();
    },
  });

  const readError = accounts.error ?? providers.error ?? harnesses.error;
  if (readError !== null) {
    return (
      <FormCard label="Providers">
        <p className="text-fine text-fail" role="alert">
          {readErrorMessage(readError)}
        </p>
      </FormCard>
    );
  }
  if (accounts.data === undefined || providers.data === undefined || harnesses.data === undefined)
    return null;
  const rows = buildProviderRows(runner, accounts.data, providers.data, harnesses.data);

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
              install.mutate(row.harnessId);
            }}
            // A sign-in ends with the controller probing the machine, so the
            // new snapshot is already stored and only needs reading.
            onSignedIn={reread}
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
  onSignedIn,
}: {
  readonly row: ProviderRow;
  readonly client: HerculeClient;
  readonly runnerId: string;
  readonly runnerName: string;
  readonly first: boolean;
  readonly busy: boolean;
  readonly onProbe: () => void;
  readonly onInstall: () => void;
  readonly onSignedIn: () => void;
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
        <span className="font-mono text-fine text-muted">
          {row.harnessName} {row.version}
        </span>
        {row.verdict === null ? null : (
          <span className="rounded-control bg-attn-soft px-1.5 text-fine text-attn">
            {row.verdict}
          </span>
        )}
      </div>
      <div className="text-row text-muted">
        {row.signedInAs} <span className="text-faint">· {row.models}</span>
      </div>
      <div className="-ml-2 flex flex-wrap items-center gap-1.5">
        {row.install === "none" ? null : (
          <Button disabled={row.install === "blocked" || busy} onClick={onInstall}>
            Install
          </Button>
        )}
        {row.signIn ? (
          <ProviderLogin
            client={client}
            providerAccountId={row.id}
            runnerId={runnerId}
            subject={`${row.name} on ${runnerName}`}
            label={row.signInLabel}
            onSignedIn={onSignedIn}
          />
        ) : null}
        {row.credentialFields.map((field) => (
          <ProviderKeyEntry
            key={`${row.id}:${field.name}`}
            client={client}
            providerAccountId={row.id}
            field={field}
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
