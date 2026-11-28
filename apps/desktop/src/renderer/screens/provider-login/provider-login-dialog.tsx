import { useRef, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { buildProviderRows, findProviderPluginId, type HerculeClient } from "@hercule/client-core";
import {
  harnessesQuery,
  pluginsQuery,
  providerAccountsQuery,
  providersQuery,
  runnersQuery,
} from "../../app/queries";
import { GlassDialog } from "../glass-dialog";
import { ProviderMark } from "../settings/providers/provider-mark";
import { MarkedRows } from "../step";
import { ProviderLogin } from "./provider-login";
import "./provider-login.css";

/**
 * Renders the sign-in of the Provider Account `providerAccountId` on the
 * runner `runnerId` in a glass dialog: the draft's Sign in button opens it
 * when the draft cannot start because the account is not signed in.
 *
 * The header names the account and the machine, such as "Sign in to
 * Anthropic · work on atlas", because a credential is stored on one machine
 * and works only there. The sign-in starts as the dialog opens, and the dialog
 * closes once the sign-in ends with the account signed in. Esc, a click on
 * the scrim, or Cancel on the row before the sign-in ends leave the account as
 * it was.
 *
 * `client` is the client of the controller the account belongs to. It is
 * passed in because the first run opens this dialog outside the routes that
 * hold a saved controller. `onSignedIn` is called once when a sign-in started
 * here ends with the account signed in, just before the dialog closes.
 *
 * With `signInAgain`, the sign-in starts although the account is signed in on
 * the machine already. The account sheet uses it to make a new token for a
 * token that is about to expire or was refused: the machine still holds the
 * old one and counts as signed in.
 *
 * `onClose` is called whenever the dialog closes, signed in or not. The
 * caller then unmounts it.
 */
export function ProviderLoginDialog({
  client,
  providerAccountId,
  runnerId,
  signInAgain = false,
  onSignedIn,
  onClose,
}: {
  readonly client: HerculeClient;
  readonly providerAccountId: string;
  readonly runnerId: string;
  readonly signInAgain?: boolean;
  readonly onSignedIn?: () => void;
  readonly onClose: () => void;
}): JSX.Element {
  const runners = useSuspenseQuery(runnersQuery(client)).data;
  const accounts = useSuspenseQuery(providerAccountsQuery(client)).data;
  const providers = useSuspenseQuery(providersQuery(client)).data;
  const harnesses = useSuspenseQuery(harnessesQuery(client)).data;
  const plugins = useSuspenseQuery(pluginsQuery(client)).data;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const runner = runners.find((each) => each.id === runnerId);
  const account = accounts.find((each) => each.id === providerAccountId);
  const foundRow =
    runner === undefined
      ? undefined
      : buildProviderRows(runner, accounts, providers, harnesses).find(
          (each) => each.id === providerAccountId,
        );
  const row = signInAgain && foundRow !== undefined ? { ...foundRow, signedIn: false } : foundRow;
  const subject =
    row === undefined || runner === undefined ? "the account" : `${row.name} on ${runner.name}`;

  return (
    <GlassDialog
      dialogRef={dialogRef}
      className="login-dialog"
      label={`Sign in to ${subject}`}
      onClose={onClose}
    >
      <div className="pop-h">
        <b>Sign in to {subject}</b>
      </div>
      <div className="pop-sec login-dialog-body">
        {row === undefined || runner === undefined ? (
          // The draft offered this sign-in from the same reads a moment ago, so
          // this shows only when the runner or the account was removed since.
          <p className="fine">That account is no longer there.</p>
        ) : (
          <MarkedRows>
            <ProviderLogin
              client={client}
              mark={
                <ProviderMark
                  pluginId={account === undefined ? null : findProviderPluginId(providers, account)}
                  plugins={plugins}
                  size={18}
                />
              }
              row={row}
              runnerId={runner.id}
              startOnOpen
              onSignedIn={() => {
                onSignedIn?.();
                dialogRef.current?.close();
              }}
            />
          </MarkedRows>
        )}
      </div>
    </GlassDialog>
  );
}
