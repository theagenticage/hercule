import { useRef, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { buildProviderRows } from "@hercule/client-core";
import {
  harnessesQuery,
  providerAccountsQuery,
  providersQuery,
  runnersQuery,
} from "../../app/queries";
import { GlassDialog } from "../glass-dialog";
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
 * `onClose` is called whenever the dialog closes, signed in or not. The
 * caller then unmounts it.
 */
export function ProviderLoginDialog({
  providerAccountId,
  runnerId,
  onClose,
}: {
  readonly providerAccountId: string;
  readonly runnerId: string;
  readonly onClose: () => void;
}): JSX.Element {
  const { controller } = useRouteContext({ from: "/_connected" });
  const runners = useSuspenseQuery(runnersQuery(controller.client)).data;
  const accounts = useSuspenseQuery(providerAccountsQuery(controller.client)).data;
  const providers = useSuspenseQuery(providersQuery(controller.client)).data;
  const harnesses = useSuspenseQuery(harnessesQuery(controller.client)).data;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const runner = runners.find((each) => each.id === runnerId);
  const row =
    runner === undefined
      ? undefined
      : buildProviderRows(runner, accounts, providers, harnesses).find(
          (each) => each.id === providerAccountId,
        );
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
              client={controller.client}
              row={row}
              runnerId={runner.id}
              startOnOpen
              onSignedIn={() => dialogRef.current?.close()}
            />
          </MarkedRows>
        )}
      </div>
    </GlassDialog>
  );
}
