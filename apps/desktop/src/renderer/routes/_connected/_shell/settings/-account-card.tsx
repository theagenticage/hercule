import { useState, type JSX } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  addModelProfileAccount,
  buildProviderAccountName,
  decideAccountState,
  describeAccountUsage,
  describeProviderAccountIdentity,
  findProviderPluginId,
  listAccountModelProfiles,
  listProviderAccountMachines,
  readErrorMessage,
  resolveBrowserTimezone,
  updateModelProfile,
  type AccountFix,
} from "@hercule/client-core";
import type { ProviderAccount } from "@hercule/contract";
import {
  harnessesQuery,
  modelProfilesQuery,
  pluginsQuery,
  providersQuery,
  runnersQuery,
} from "../../../../app/queries";
import { ProviderAccountCard, ProviderMark } from "../../../../screens/settings/providers";
import { replaceCachedModelProfile } from "./-model-profile-cache";
import { useOpenModelProfile } from "./-open-model-profile";

/**
 * Renders the card of the Provider Account `account` on the Providers page.
 * It exists apart from `ProviderAccountCard`, which only draws, so that each
 * card reads its own lists and a push redraws only the card whose account
 * changed. It reads what it needs to name the account and to work out its
 * machines, usage and state. The `provider` live topic reads the accounts
 * again when any account's usage moves, and the cache keeps the record of an
 * account that did not change as it was, so the cards of the others stay as
 * they are. It also reads the Model Profiles, for the faces of the ones that
 * hold the account, and the open profile (`useOpenModelProfile`), for "Use in
 * <profile>". Pressing that adds the account to the open profile with its
 * provider's Default Selection (`addModelProfileAccount`). The save waits in
 * line behind the Models section's saves (the "model-profile" mutation scope),
 * is built from the newest copy of the profile the page holds, and puts the
 * answer in the cache, as they do.
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
  const queryClient = useQueryClient();
  const { profile: openProfile, profiles } = useOpenModelProfile(client);
  const [timezone] = useState(() => resolveBrowserTimezone());
  const addToProfile = useMutation({
    scope: { id: "model-profile" },
    mutationFn: (profileId: string) => {
      const newest = queryClient
        .getQueryData(modelProfilesQuery(client).queryKey)
        ?.find((each) => each.id === profileId);
      if (newest === undefined) throw new Error("The profile is gone.");
      return updateModelProfile(client, newest, (current) =>
        addModelProfileAccount(current, account.id),
      );
    },
    onSuccess: (saved) => {
      replaceCachedModelProfile(queryClient, client, saved);
    },
  });
  // The save belongs to the profile it was started on, so a tab switched to
  // meanwhile shows neither its wait nor its refusal.
  const startedHere = addToProfile.variables === openProfile?.id;
  const holders = listAccountModelProfiles(profiles, account.id);
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
      profileUse={
        openProfile === undefined
          ? null
          : {
              holders,
              openName: openProfile.name,
              inOpen: holders.some(({ id }) => id === openProfile.id),
              severalProfiles: profiles.length > 1,
              saving: startedHere && addToProfile.isPending,
              error:
                startedHere && addToProfile.isError
                  ? `${name} was not added to ${openProfile.name}. ${readErrorMessage(addToProfile.error)}`
                  : null,
            }
      }
      onOpen={() => {
        onOpen(account.id, name);
      }}
      onUse={() => {
        if (openProfile !== undefined) addToProfile.mutate(openProfile.id);
      }}
      onFix={(fix) => {
        onFix(account.id, name, fix);
      }}
    />
  );
}
