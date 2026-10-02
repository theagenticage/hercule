import { useRef, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { buildProviderRows, type LoginTarget } from "@hercule/client-core";
import { providersQuery, runnersQuery } from "../../app/queries";
import { GlassDialog } from "../glass-dialog";
import { MarkedRows } from "../step";
import { ProviderLogin } from "./provider-login";
import "./provider-login.css";

/**
 * Renders the login of `target` in a glass dialog: the draft's Log in button
 * opens it when the draft cannot start because a provider instance is not
 * logged in.
 *
 * The header names the instance and the machine, such as "Log in to Claude
 * Code on atlas", because a credential is stored on one machine and works only
 * there. The login starts as the dialog opens, and the dialog closes once the
 * login ends with the harness logged in. Esc, a click on the scrim, or Cancel
 * on the row before the login ends leave the harness as it was.
 *
 * `onClose` is called whenever the dialog closes, logged in or not. The
 * caller then unmounts it.
 */
export function ProviderLoginDialog({
  target,
  onClose,
}: {
  readonly target: LoginTarget;
  readonly onClose: () => void;
}): JSX.Element {
  const { controller } = useRouteContext({ from: "/_connected" });
  const runners = useSuspenseQuery(runnersQuery(controller.client)).data;
  const instances = useSuspenseQuery(providersQuery(controller.client)).data;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const runner = runners.find((each) => each.id === target.runnerId);
  const row =
    runner === undefined
      ? undefined
      : buildProviderRows(runner, instances).find((each) => each.id === target.instanceId);

  return (
    <GlassDialog
      dialogRef={dialogRef}
      className="login-dialog"
      label={`Log in to ${target.subject}`}
      onClose={onClose}
    >
      <div className="pop-h">
        <b>Log in to {target.subject}</b>
      </div>
      <div className="pop-sec login-dialog-body">
        {row === undefined || runner === undefined ? (
          // The draft offered this login from the same reads a moment ago, so
          // this shows only when the runner or the instance was removed since.
          <p className="fine">{target.subject} is no longer there.</p>
        ) : (
          <MarkedRows>
            <ProviderLogin
              row={row}
              runnerId={runner.id}
              startOnOpen
              onLoggedIn={() => dialogRef.current?.close()}
            />
          </MarkedRows>
        )}
      </div>
    </GlassDialog>
  );
}
