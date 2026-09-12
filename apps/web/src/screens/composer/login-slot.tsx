import type { ReactNode } from "react";
import type { HydraClient, LoginTarget } from "@hydra/client-core";
import { ProviderLogin } from "../provider-login";

/**
 * What fills the Log in affordance wherever one is offered: the draft's own
 * blocker, or an account's row in the model menu. The target names itself,
 * because the row offering the login is often not the account in force, and
 * it names its machine too - a credential lands on one machine and works only
 * there (spec 06 §3.1).
 */
export const loginSlot =
  (client: HydraClient, onLoggedIn: () => void) =>
  (login: LoginTarget, className: string): ReactNode => (
    <ProviderLogin
      className={className}
      client={client}
      instanceId={login.instanceId}
      runnerId={login.runnerId}
      subject={login.displayName}
      label="Log in"
      onLoggedIn={onLoggedIn}
    />
  );
