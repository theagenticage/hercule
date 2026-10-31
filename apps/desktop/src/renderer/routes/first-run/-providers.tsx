import type { JSX } from "react";
import {
  buildFirstRunHost,
  buildProviderRows,
  buildProvidersStepText,
  type HerculeClient,
} from "@hercule/client-core";
import type { Harness, Provider, ProviderAccount, Runner } from "@hercule/contract";
import { ProvidersStep } from "../../screens/first-run";
import { ProviderLogin } from "../../screens/provider-login";

/**
 * Renders the providers step: the accounts on the controller's runner,
 * `localRunner`, each with its own sign-in. Continue waits for a sign-in to be
 * `ready`. Until the runner joins, the step shows that it waits for the runner.
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
  const text = buildProvidersStepText(
    localRunner === null ? null : buildProviderRows(localRunner, accounts, providers, harnesses),
    buildFirstRunHost(origin, localRunner),
  );
  return (
    <ProvidersStep
      heading={text.heading}
      subheading={text.subheading}
      ready={ready}
      onContinue={onContinue}
      onPutOff={onPutOff}
    >
      {localRunner === null
        ? null
        : text.rows.map((row) => (
            <ProviderLogin key={row.id} client={client} row={row} runnerId={localRunner.id} />
          ))}
    </ProvidersStep>
  );
}
