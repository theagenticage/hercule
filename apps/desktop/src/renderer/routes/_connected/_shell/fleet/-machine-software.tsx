import { useState, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { listMachineAccounts, listMachineHarnesses } from "@hercule/client-core/machine-page";
import { listMachineTools } from "@hercule/client-core/software";
import type { Runner } from "@hercule/contract";
import { harnessesQuery, providerAccountsQuery, providersQuery } from "../../../../app/queries";
import { MachinePageSoftware } from "../../../../screens/fleet/machine-page-software";
import { ProviderLoginDialog } from "../../../../screens/provider-login";

/**
 * Renders the Software section of the machine `runner`'s page (spec 17
 * §Fleet, A machine's page): its harnesses, and the accounts that sign in on
 * each machine with who is signed in here, and the tools found on it.
 *
 * Sign in opens the account's sign-in dialog for this machine, the one
 * Settings > Providers' account sheet opens. The `provider` live topic keeps
 * the accounts current, so a sign-in that ends shows in the row at once.
 */
export function MachineSoftware({
  id,
  runner,
}: {
  readonly id: string;
  readonly runner: Runner;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const harnesses = useSuspenseQuery(harnessesQuery(client)).data;
  const providers = useSuspenseQuery(providersQuery(client)).data;
  const accounts = useSuspenseQuery(providerAccountsQuery(client)).data;
  const [signInAccountId, setSignInAccountId] = useState<string | null>(null);
  return (
    <>
      <MachinePageSoftware
        id={id}
        harnesses={listMachineHarnesses(harnesses, runner.id)}
        accounts={listMachineAccounts(runner, accounts, providers, harnesses)}
        tools={listMachineTools(runner)}
        isAway={runner.connectivity !== "online"}
        onSignIn={setSignInAccountId}
      />
      {signInAccountId !== null && (
        <ProviderLoginDialog
          client={client}
          providerAccountId={signInAccountId}
          runnerId={runner.id}
          onClose={() => setSignInAccountId(null)}
        />
      )}
    </>
  );
}
