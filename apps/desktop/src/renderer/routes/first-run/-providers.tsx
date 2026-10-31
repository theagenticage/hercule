import { Suspense, useState, type JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  buildFirstRunHost,
  buildProviderRows,
  buildProvidersStepText,
  findProviderPluginId,
  type HerculeClient,
} from "@hercule/client-core";
import type { Harness, Provider, ProviderAccount, Runner } from "@hercule/contract";
import { ProvidersStep } from "../../screens/first-run";
import { pluginsQuery } from "../../app/queries";
import { ProviderLogin } from "../../screens/provider-login";
import { LazyAddProviderAccount } from "../../screens/settings/providers/lazy-add-provider-account";
import { ProviderMark } from "../../screens/settings/providers/provider-mark";

/**
 * Renders the providers step, "Add an account": the accounts that exist, each
 * with its own sign-in on the controller's runner, `localRunner`, and Add an
 * account, which opens the add-account sheet with that runner as the machine a
 * sign-in runs on. Continue waits for a sign-in to be `ready`. Until the
 * runner joins, the step shows that it waits for the runner.
 */
export function ProvidersCard({
  client,
  origin,
  localRunner,
  accounts,
  providers,
  harnesses,
  ready,
  onContinue,
  onPutOff,
}: {
  readonly client: HerculeClient;
  /** The controller's origin, from which the step works out whether the runner is on this Mac. */
  readonly origin: string;
  readonly localRunner: Runner | null;
  readonly accounts: readonly ProviderAccount[];
  readonly providers: readonly Provider[];
  readonly harnesses: readonly Harness[];
  readonly ready: boolean;
  readonly onContinue: () => void;
  readonly onPutOff: () => void;
}): JSX.Element {
  const [adding, setAdding] = useState(false);
  // The marks of the providers come from the plugins. The step draws without
  // them, and the marks fill in when they are read.
  const plugins = useQuery(pluginsQuery(client)).data ?? [];
  const text = buildProvidersStepText(
    localRunner === null ? null : buildProviderRows(localRunner, accounts, providers, harnesses),
    buildFirstRunHost(origin, localRunner),
  );
  return (
    <>
      <ProvidersStep
        heading={text.heading}
        subheading={text.subheading}
        ready={ready}
        listsAccounts={text.rows.length > 0}
        onAddAccount={
          localRunner === null
            ? null
            : () => {
                setAdding(true);
              }
        }
        onContinue={onContinue}
        onPutOff={onPutOff}
      >
        {localRunner === null
          ? null
          : text.rows.map((row) => {
              const account = accounts.find(({ id }) => id === row.id);
              return (
                <ProviderLogin
                  key={row.id}
                  client={client}
                  mark={
                    <ProviderMark
                      pluginId={
                        account === undefined ? null : findProviderPluginId(providers, account)
                      }
                      plugins={plugins}
                      size={18}
                    />
                  }
                  row={row}
                  runnerId={localRunner.id}
                />
              );
            })}
      </ProvidersStep>
      {adding && (
        // Without its own boundary, the sheet's load would suspend the step behind it.
        <Suspense fallback={null}>
          <LazyAddProviderAccount
            client={client}
            signInMachines="controller"
            onClose={() => {
              setAdding(false);
            }}
          />
        </Suspense>
      )}
    </>
  );
}
