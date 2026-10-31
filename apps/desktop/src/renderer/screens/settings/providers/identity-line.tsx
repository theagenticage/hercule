import type { JSX } from "react";
import type { AccountIdentityLine } from "@hercule/client-core";
import "./providers.css";

/**
 * Renders the line under an account's name on one line. The identity ends in
 * an ellipsis when the line is too narrow, and the plan after it stays whole:
 * "rogier@acme.com · Max" ends as "rogier@ac… · Max". The whole line is the
 * tooltip.
 */
export function IdentityLine({
  line,
  className,
}: {
  readonly line: AccountIdentityLine;
  readonly className: string;
}): JSX.Element {
  const { text, plan } = line;
  return (
    <span className={`pa-identity ${className}`} title={plan === null ? text : `${text} · ${plan}`}>
      <span className="pa-identity-text">{text}</span>
      {plan !== null && <span className="pa-identity-plan">{` · ${plan}`}</span>}
    </span>
  );
}
