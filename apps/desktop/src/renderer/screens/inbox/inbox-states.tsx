import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import type { PluginIdentity } from "@hercule/client-core";
import type { SourceOffer } from "@hercule/client-core/inbox";
import { HERCULE_LOOK } from "../../faces";
import { ArrowIcon } from "../../icons/arrow";
import { PluginMark } from "../../marks";
import { Colleague, SectionHeading, Sunrise } from "../desk";
import "../desk/card.css";

/**
 * Renders one source the page asks the user to connect: its mark, its name,
 * what it brings, and "Connect", which opens Settings > Connections where
 * the source is added.
 */
function SourceOfferCard({
  offer,
  plugins,
}: {
  readonly offer: SourceOffer;
  readonly plugins: readonly PluginIdentity[];
}): JSX.Element {
  return (
    <Link to="/settings/connections" className="inbox-offer">
      <PluginMark pluginId={offer.pluginId} plugins={plugins} size={20} />
      <span className="offer-words">
        <b>{offer.name}</b>
        <small>{offer.line}</small>
      </span>
      <span className="offer-go">
        Connect <ArrowIcon size={12} />
      </span>
    </Link>
  );
}

/**
 * Renders the first run: the real page, with no dialog. Hercule hands over
 * one line saying what the place is, Ongoing asks for the sources whose cards
 * will lie there and Requests for the ones whose cards will arrive. Both
 * lists are the `offers` of `decideEmptyInbox`, each on the side its kind
 * lies on.
 */
export function FirstRun({
  offers,
  plugins,
}: {
  readonly offers: readonly SourceOffer[];
  readonly plugins: readonly PluginIdentity[];
}): JSX.Element {
  return (
    <>
      <div className="inbox-wide">
        <div className="inbox-welcome">
          <Colleague look={HERCULE_LOOK} pose="idle" seed="hercule" still />
          <i className="card-stock" />
          <p>
            This is where the outside world reaches you.
            <small>
              Connect what you work in. What concerns you lands here as cards, each with its history
              inside it.
            </small>
          </p>
        </div>
        <div className="inbox-section-head">
          <SectionHeading name="Ongoing" count={0} />
        </div>
        <div className="inbox-offers-grid">
          {offers
            .filter((offer) => offer.side === "ongoing")
            .map((offer) => (
              <SourceOfferCard key={offer.pluginId} offer={offer} plugins={plugins} />
            ))}
        </div>
      </div>
      <aside className="inbox-narrow" aria-label="Requests">
        <div className="inbox-section-head">
          <SectionHeading name="Requests" count={0} />
        </div>
        <div className="inbox-offers-list">
          {offers
            .filter((offer) => offer.side === "requests")
            .map((offer) => (
              <SourceOfferCard key={offer.pluginId} offer={offer} plugins={plugins} />
            ))}
        </div>
      </aside>
    </>
  );
}

/**
 * Renders the Inbox with nothing at all in it: a sunrise 440px wide, Hercule
 * coming up over a brass horizon, and "All clear." `isStill` draws it at rest,
 * for a page that opens empty. Only the user's own action that empties the
 * Inbox plays the arrival.
 */
export function AllClear({ isStill }: { readonly isStill: boolean }): JSX.Element {
  return (
    <div className="inbox-clear">
      <Sunrise width={440} isStill={isStill} />
      <h2>All clear.</h2>
      <p>Anything from outside that concerns you will land here.</p>
    </div>
  );
}
