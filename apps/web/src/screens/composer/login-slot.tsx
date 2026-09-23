import type { ReactNode } from "react";
import type { HerculeClient, LoginTarget } from "@hercule/client-core";
import { ProviderLogin } from "../provider-login";

/**
 * Returns a function that renders the Log in button wherever one is offered:
 * in the draft's blocker, or on an account's row in the model menu.
 *
 * The button names its full target, such as `Claude Code on atlas`. It names
 * the account because the row offering the login is often not the account in
 * use. It names the machine because a credential is stored on one machine and
 * works only there (spec 06 §3.1).
 */
export const buildLoginSlot =
  (client: HerculeClient, onLoggedIn: () => void) =>
  (login: LoginTarget, className: string): ReactNode => (
    <ProviderLogin
      className={className}
      client={client}
      instanceId={login.instanceId}
      runnerId={login.runnerId}
      subject={login.subject}
      label="Log in"
      onLoggedIn={onLoggedIn}
    />
  );
