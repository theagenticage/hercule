import { useRef, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  buildProviderAccountName,
  listProviderAccountCredentialFields,
  listSignInRunnerOptions,
  type AccountFix,
} from "@hercule/client-core";
import type { ProviderAccount } from "@hercule/contract";
import {
  controllerQuery,
  harnessesQuery,
  providersQuery,
  runnersQuery,
} from "../../../../app/queries";
import { ConfirmDialog } from "../../../../screens/confirm-dialog";
import { ProviderLoginDialog, ReplaceKeyDialog } from "../../../../screens/provider-login";

/** The fixes that give an account a new credential. The third, Sign in, opens the account's sheet instead. */
export type CredentialFix = Extract<AccountFix, { kind: "replace-key" | "new-token" }>;

/**
 * Renders the flow that gives the Provider Account `account` a new
 * credential, over whatever is open (spec 17 §Settings, Providers). It reuses
 * the flows that exist, and starts no new one:
 *
 * - Replace key: the first run's entry of a credential field, in a dialog.
 *   The controller checks the key before it stores it.
 * - Make a new token: the sign-in dialog of the add-account sheet, on a
 *   machine that has Claude Code, or can install it. It asks for the
 *   controller's machine first. When no machine can run Claude Code now, a
 *   dialog says so.
 *
 * It reads the controller's record, which the first run's reads also load,
 * so a caller wraps it in a `Suspense` boundary of its own. `onClose` is
 * called whenever the flow closes, finished or not; the caller then unmounts it.
 */
export function FixAccountDialog({
  account,
  fix,
  onClose,
}: {
  readonly account: ProviderAccount;
  readonly fix: CredentialFix;
  readonly onClose: () => void;
}): JSX.Element | null {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const providers = useSuspenseQuery(providersQuery(client)).data;
  const name = buildProviderAccountName(providers, account);
  if (fix.kind === "new-token") {
    return <NewTokenDialog account={account} name={name} onClose={onClose} />;
  }
  const field = listProviderAccountCredentialFields(providers, account)[0];
  // A key account has a credential field by definition; only a kind its
  // provider no longer declares has none, and it has no Replace key button.
  return field === undefined ? null : (
    <ReplaceKeyDialog
      client={client}
      providerAccountId={account.id}
      name={name}
      field={{ name: field.name, title: field.label, description: field.help ?? "" }}
      onClose={onClose}
    />
  );
}

/** Renders the token flow of `account` on the first machine that can run it, or says that none can. */
function NewTokenDialog({
  account,
  name,
  onClose,
}: {
  readonly account: ProviderAccount;
  readonly name: string;
  readonly onClose: () => void;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const harnesses = useSuspenseQuery(harnessesQuery(client)).data;
  const runners = useSuspenseQuery(runnersQuery(client)).data;
  const controllerRunnerId = useSuspenseQuery(controllerQuery(client)).data.localRunnerId;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const harness = harnesses.find(({ id }) => id === account.defaultHarnessId);
  const runnerId =
    harness === undefined
      ? null
      : listSignInRunnerOptions(runners, harness, "create-token", controllerRunnerId)
          .defaultRunnerId;

  if (runnerId === null) {
    return (
      <ConfirmDialog
        dialogRef={dialogRef}
        title={`Make a new token for ${name}`}
        actionLabel="Make a new token"
        actionClass="accent"
        closeLabel="Close"
        refusal={`No machine can run ${harness?.displayName ?? "its harness"} now. Connect a machine that has it, or can install it, and try again.`}
        onConfirm={onClose}
        onClose={onClose}
      >
        <p>
          A token is made by signing in on a machine that runs{" "}
          {harness?.displayName ?? "its harness"}.
        </p>
      </ConfirmDialog>
    );
  }
  return (
    <ProviderLoginDialog
      client={client}
      providerAccountId={account.id}
      runnerId={runnerId}
      signInAgain
      onClose={onClose}
    />
  );
}
