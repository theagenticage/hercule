import type { ReactNode } from "react";
import type { HerculeClient, SignInTarget } from "@hercule/client-core";
import { ProviderLogin } from "../provider-login";

/**
 * Returns a function that renders the Sign in button wherever one is offered:
 * in the draft's blocker, or on an account's row in the model menu.
 *
 * The sign-in drawer names its full target, such as `Sign in to Anthropic on
 * atlas`. It names the account because the row offering the sign-in is often
 * not the account in use. It names the machine because a credential is stored
 * on one machine and works only there. Spec 06 §3.1 owns that rule.
 */
export const buildSignInSlot =
  (client: HerculeClient, onSignedIn: () => void) =>
  (target: SignInTarget, className: string): ReactNode => (
    <ProviderLogin
      className={className}
      client={client}
      providerAccountId={target.providerAccountId}
      runnerId={target.runnerId}
      subject={target.subject}
      label="Sign in"
      onSignedIn={onSignedIn}
    />
  );
