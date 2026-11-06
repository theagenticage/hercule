import type { JSX } from "react";
import type { ProviderAccountReachView } from "@hercule/client-core";
import { FleetIcon } from "../../../icons/fleet";
import { GlobeIcon } from "../../../icons/globe";
import "./providers.css";

/**
 * Renders where an account works, in the form `reach` has (see
 * `ProviderAccountReachView`): the globe and "All" for a credential every
 * machine uses, else the fleet icon and one of "No machines", a pip per machine
 * (filled where the account is ready, a ring where it is not) or a count such
 * as "2/5", in the attention ink when a machine is not ready. The whole is one
 * image with the description as its name and its tooltip, because a pip has no
 * words of its own; the icons are decoration.
 */
export function AccountReach({ reach }: { readonly reach: ProviderAccountReachView }): JSX.Element {
  return (
    <span className="pa-reach" role="img" aria-label={reach.description} title={reach.description}>
      {reach.form === "shared" ? <GlobeIcon size={11} /> : <FleetIcon size={11} />}
      {reach.form === "shared" && <span className="pa-reach-all">All</span>}
      {reach.form === "none" && "No machines"}
      {reach.form === "pips" &&
        reach.pips.map(({ runnerId, ready }) => (
          <i key={runnerId} className={ready ? "pa-pip" : "pa-pip is-you"} />
        ))}
      {reach.form === "count" && (
        <span className={reach.needsAttention ? "pa-reach-count is-you" : "pa-reach-count"}>
          {reach.count}
        </span>
      )}
    </span>
  );
}
