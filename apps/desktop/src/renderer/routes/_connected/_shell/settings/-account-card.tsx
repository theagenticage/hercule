import { useState, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  buildProviderAccountName,
  decideAccountState,
  describeAccountUsage,
  describeProviderAccountIdentity,
  findProviderPluginId,
  listProviderAccountMachines,
  resolveBrowserTimezone,
  type AccountFix,
} from "@hercule/client-core";
import type { ProviderAccount } from "@hercule/contract";
import {
  harnessesQuery,
  pluginsQuery,
  providersQuery,
  runnersQuery,
} from "../../../../app/queries";
import { ProviderAccountCard, ProviderMark } from "../../../../screens/settings/providers";

/**
 * Renders the card of the Provider Account `account` on the Providers page.
 * It exists apart from `ProviderAccountCard`, which only draws, so that each
 * card reads its own lists and a push redraws only the card whose account
 * changed. It reads what it needs to name the account and to work out its
 * machines, usage and state. The `provider` live topic reads the accounts
 * again when any account's usage moves, and the cache keeps the record of an
 * account that did not change as it was, so the cards of the others stay as
 * they are.
 *
 * `onOpen` is called with the account's id and name, the name as the card
 * shows it, when the card is pressed. `onFix` is called with the same two and
 * the fix when the button that fixes its state is pressed.
 */
export function AccountCard({
  account,
  onOpen,
  onFix,
}: {
  readonly account: ProviderAccount;
  readonly onOpen: (providerAccountId: string, name: string) => void;
  readonly onFix: (providerAccountId: string, name: string, fix: AccountFix) => void;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const providers = useSuspenseQuery(providersQuery(client)).data;
  const harnesses = useSuspenseQuery(harnessesQuery(client)).data;
  const runners = useSuspenseQuery(runnersQuery(client)).data;
  const plugins = useSuspenseQuery(pluginsQuery(client)).data;
  const [timezone] = useState(() => resolveBrowserTimezone());
  // Usage and expiry are worked out as the card draws, and not kept current:
  // a push that changes them draws it again.
  const now = new Date();
  const name = buildProviderAccountName(providers, account);
  return (
    <ProviderAccountCard
      mark={
        <ProviderMark
          pluginId={findProviderPluginId(providers, account)}
          plugins={plugins}
          size={15}
        />
      }
      name={name}
      identity={describeProviderAccountIdentity(providers, account)}
      machines={listProviderAccountMachines(account, runners, providers, harnesses)}
      usage={describeAccountUsage(account, timezone, now)}
      state={decideAccountState(providers, account, timezone, now)}
      onOpen={() => {
        onOpen(account.id, name);
      }}
      onFix={(fix) => {
        onFix(account.id, name, fix);
      }}
    />
  );
}
