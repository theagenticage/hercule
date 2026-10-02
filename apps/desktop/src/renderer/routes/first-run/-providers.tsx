import type { JSX } from "react";
import {
  buildFirstRunHost,
  buildProviderRows,
  buildProvidersStepText,
  type HerculeClient,
} from "@hercule/client-core";
import type { ProviderInstance, Runner } from "@hercule/contract";
import { ProvidersStep } from "../../screens/first-run";
import { ProviderLogin } from "../../screens/provider-login";

/**
 * Renders the providers step: the harnesses on the controller's runner,
 * `localRunner`, each with its own login. Continue waits for a login to be
 * `ready`. Until the runner joins, the step says it is waiting for it.
 */
export function ProvidersCard({
  client,
  origin,
  localRunner,
  instances,
  ready,
  onContinue,
  onPutOff,
}: {
  readonly client: HerculeClient;
  /** The controller's origin, which tells whether the runner is on this Mac. */
  readonly origin: string;
  readonly localRunner: Runner | null;
  readonly instances: readonly ProviderInstance[];
  readonly ready: boolean;
  readonly onContinue: () => void;
  readonly onPutOff: () => void;
}): JSX.Element {
  const text = buildProvidersStepText(
    localRunner === null ? null : buildProviderRows(localRunner, instances),
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
