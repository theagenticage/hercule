import { useState, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  buildProviderAccountName,
  describeAccountIdentity,
  listAccountMachines,
  requiresSignInPerMachine,
} from "@hercule/client-core";
import { rememberSettingsSection } from "../../../../app/last-settings-section";
import {
  harnessesQuery,
  pluginsQuery,
  providerAccountsQuery,
  providersQuery,
  runnersQuery,
} from "../../../../app/queries";
import { AccountCard, ProviderMark } from "../../../../screens/settings/providers";
import { ProviderAccountSheet } from "./-provider-account-sheet";

/**
 * The account whose sheet is open. It holds the account's id, not the
 * account, so the sheet always shows the account as the live list holds it
 * now. `name` is the name its card showed when the sheet opened, kept to say
 * which account went if it is deleted elsewhere while the sheet is open.
 */
interface OpenSheet {
  readonly accountId: string;
  readonly name: string;
}

/**
 * Settings > Providers: the Accounts section, one card per Provider Account
 * in the order the accounts were added. A card shows the provider's mark, the
 * account's name, who is signed in and the plan, and either the machines the
 * account is signed in on or "Every machine". A click on a card opens the
 * account's sheet (spec 17 §Settings, Providers).
 *
 * Everything the section reads, the accounts, the providers, the harnesses,
 * the runners and the plugins, is a shell read that the live connection
 * keeps current: the `provider` topic for the accounts, which the shell
 * holds, so opening the section sends no request and the section holds no
 * subscription of its own. The loader only makes sure the cache holds them.
 */
export const Route = createFileRoute("/_connected/_shell/settings/providers")({
  staticData: { title: "Providers" },
  loader: async ({ context: { controller, queryClient } }) => {
    const { client } = controller;
    await Promise.all([
      queryClient.ensureQueryData(providerAccountsQuery(client)),
      queryClient.ensureQueryData(providersQuery(client)),
      queryClient.ensureQueryData(harnessesQuery(client)),
      queryClient.ensureQueryData(runnersQuery(client)),
      queryClient.ensureQueryData(pluginsQuery(client)),
    ]);
  },
  onEnter: () => {
    rememberSettingsSection("/settings/providers");
  },
  component: Providers,
});

function Providers(): JSX.Element {
  const { client } = Route.useRouteContext().controller;
  const accounts = useSuspenseQuery(providerAccountsQuery(client)).data;
  const providers = useSuspenseQuery(providersQuery(client)).data;
  const harnesses = useSuspenseQuery(harnessesQuery(client)).data;
  const runners = useSuspenseQuery(runnersQuery(client)).data;
  const plugins = useSuspenseQuery(pluginsQuery(client)).data;
  const [sheet, setSheet] = useState<OpenSheet | null>(null);
  // A sheet closes only itself: a late close of a sheet the user left must
  // not close the one opened since.
  const closeSheet = (closing: OpenSheet): void => {
    setSheet((current) => (current === closing ? null : current));
  };
  const sheetAccount = accounts.find(({ id }) => id === sheet?.accountId);

  if (accounts.length === 0) {
    return <p className="pa-empty">No accounts yet.</p>;
  }
  return (
    <>
      <section className="set-sec provider-accounts">
        <h2>Accounts</h2>
        <p className="pa-lead">Who pays for the models in your menu.</p>
        {sheet !== null && sheetAccount === undefined && (
          <p className="set-note" role="status">
            {`${sheet.name} was deleted elsewhere, so its sheet closed.`}
          </p>
        )}
        <div className="pa-cards">
          {accounts.map((account) => {
            const name = buildProviderAccountName(providers, account);
            return (
              <AccountCard
                key={account.id}
                mark={<ProviderMark providerId={account.providerId} plugins={plugins} size={15} />}
                name={name}
                identity={describeAccountIdentity(providers, account)}
                machines={
                  requiresSignInPerMachine(providers, account)
                    ? listAccountMachines(account, runners, providers, harnesses)
                    : null
                }
                onOpen={() => {
                  setSheet({ accountId: account.id, name });
                }}
              />
            );
          })}
        </div>
      </section>
      {sheet !== null && sheetAccount !== undefined && (
        <ProviderAccountSheet
          account={sheetAccount}
          onClose={() => {
            closeSheet(sheet);
          }}
        />
      )}
    </>
  );
}
