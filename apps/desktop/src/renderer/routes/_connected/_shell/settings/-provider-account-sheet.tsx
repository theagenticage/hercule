import { useRef, useState, type JSX } from "react";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  buildProviderAccountName,
  describeProviderAccountIdentity,
  findProviderPluginId,
  listProviderAccountMachines,
  queryKeys,
  readErrorMessage,
  type ProviderAccountMachine,
  type HerculeClient,
} from "@hercule/client-core";
import type { ProviderAccount, ProviderAccountUpdateInput } from "@hercule/contract";
import {
  harnessesQuery,
  localRunnerQuery,
  pluginsQuery,
  providerAccountsQuery,
  providersQuery,
  runnersQuery,
} from "../../../../app/queries";
import { useSavedRecordField } from "../../../../app/saved-record-field";
import { ProviderLoginDialog } from "../../../../screens/provider-login";
import {
  ProviderAccountNameField,
  ProviderAccountSheet,
  ProviderAccountSheetSection,
  MachineRow,
  ProviderMark,
  type MachineAction,
} from "../../../../screens/settings/providers";
import { useTextDraft } from "../../../../screens/settings/use-text-draft";
import { DeleteProviderAccountDialog } from "./-delete-provider-account-dialog";

/**
 * Returns the label field of the account `account`: it saves on every
 * commit through `providerAccount.update`. Text with nothing but spaces
 * removes the label. The controller refuses a change the account may not
 * make, such as removing the label of the second account at one provider,
 * and its message becomes `error`.
 */
function useSavedProviderAccountLabel(client: HerculeClient, account: ProviderAccount) {
  return useSavedRecordField<ProviderAccount, string, string, ProviderAccountUpdateInput>({
    listKey: providerAccountsQuery(client).queryKey,
    id: account.id,
    stored: account.label ?? "",
    applyChange: (_shown, change) => change,
    buildPayload: (latest, change) => {
      const label = change.trim() === "" ? null : change.trim();
      return label === latest.label ? {} : { label };
    },
    update: (id, payload) => client.providerAccount.update({ params: { id }, payload }),
  });
}

/**
 * Renders the sheet of the Provider Account `account` over the Providers
 * page (spec 17 §Settings, Providers):
 *
 * - Name: the label, edited in place;
 * - Machines, for an account that signs in on each machine: whether it is
 *   signed in on each runner and as whom, Sign in where it is not (the login
 *   dialog of the first run), and Install where the runner lacks the harness;
 * - Delete, which asks first.
 *
 * The page passes the account from the cached list, which the `provider`
 * live topic keeps current, so a sign-in that ends shows in the machine's
 * row at once. `onClose` is called whenever the sheet closes.
 */
export function OpenedProviderAccountSheet({
  account,
  onClose,
}: {
  readonly account: ProviderAccount;
  readonly onClose: () => void;
}): JSX.Element {
  const { bridge, controller } = useRouteContext({ from: "/_connected" });
  const { client } = controller;
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const providers = useSuspenseQuery(providersQuery(client)).data;
  const harnesses = useSuspenseQuery(harnessesQuery(client)).data;
  const runners = useSuspenseQuery(runnersQuery(client)).data;
  const plugins = useSuspenseQuery(pluginsQuery(client)).data;
  const thisMacRunnerId = useQuery(localRunnerQuery(bridge, runners)).data ?? null;
  const [loginRunnerId, setLoginRunnerId] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const label = useSavedProviderAccountLabel(client, account);
  const draft = useTextDraft(label.value, label.save);
  const install = useMutation({
    mutationFn: (machine: ProviderAccountMachine) =>
      client.runner.installHarness({
        params: { id: machine.runnerId },
        payload: { harnessId: account.defaultHarnessId },
      }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.runners() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.harnesses() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.providerAccounts() }),
      ]),
  });

  const name = buildProviderAccountName(providers, account);
  const machines = listProviderAccountMachines(account, runners, providers, harnesses);
  // `client-core` decides which action a machine offers; this only draws it
  // and says what pressing it does.
  const buildMachineButton = (machine: ProviderAccountMachine): MachineAction | null => {
    const { action } = machine;
    if (action === null) return null;
    if (action.kind === "install") {
      const installing = install.isPending && install.variables.runnerId === machine.runnerId;
      return {
        label: installing ? "Installing…" : "Install",
        onPress: () => {
          install.mutate(machine);
        },
        pending: install.isPending,
      };
    }
    if (action.kind === "sign-in") {
      return { label: "Sign in", onPress: () => setLoginRunnerId(machine.runnerId) };
    }
    return { label: "Sign in", onPress: () => undefined, unavailable: action.reason };
  };

  return (
    <>
      <ProviderAccountSheet
        dialogRef={dialogRef}
        mark={
          <ProviderMark
            pluginId={findProviderPluginId(providers, account)}
            plugins={plugins}
            size={16}
          />
        }
        name={name}
        identity={describeProviderAccountIdentity(providers, account)}
        onClose={onClose}
      >
        <ProviderAccountSheetSection heading="Name">
          <ProviderAccountNameField
            draft={draft}
            placeholder="Work, Personal, Team…"
            hint={`Shown after the provider, as in ${buildProviderAccountName(providers, { providerId: account.providerId, label: "Work" })}. It tells your accounts apart in menus.`}
            error={label.error}
          />
        </ProviderAccountSheetSection>
        {machines !== null && (
          <ProviderAccountSheetSection heading="Machines">
            {machines.map((machine) => (
              <MachineRow
                key={machine.runnerId}
                runnerName={machine.runnerName}
                isThisMac={machine.runnerId === thisMacRunnerId}
                signedIn={machine.signedIn}
                identity={machine.identity}
                action={buildMachineButton(machine)}
                error={
                  install.isError && install.variables.runnerId === machine.runnerId
                    ? readErrorMessage(install.error)
                    : null
                }
              />
            ))}
          </ProviderAccountSheetSection>
        )}
        <ProviderAccountSheetSection heading={`Delete ${name}`}>
          <button
            type="button"
            className="btn btn--danger"
            onClick={() => setConfirmingDelete(true)}
          >
            Delete…
          </button>
        </ProviderAccountSheetSection>
      </ProviderAccountSheet>
      {loginRunnerId !== null && (
        <ProviderLoginDialog
          providerAccountId={account.id}
          runnerId={loginRunnerId}
          onClose={() => setLoginRunnerId(null)}
        />
      )}
      {confirmingDelete && (
        <DeleteProviderAccountDialog
          providerAccountId={account.id}
          name={name}
          onDeleted={onClose}
          onClose={() => setConfirmingDelete(false)}
        />
      )}
    </>
  );
}
