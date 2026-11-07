import type { JSX } from "react";
import { SectionHeading } from "../desk";

/** How many cards each place of the first-ever loading page holds. */
const LOADING_ROWS_OF_PLACES: readonly number[] = [2, 1, 2];

/** How many requests the first-ever loading page holds. */
const LOADING_REQUESTS = 7;

/**
 * Renders the Inbox while its very first read is on its way, when nothing is
 * known of what lies on it: the two sides as they will stand, each card two
 * quiet bars where its words will be. A card keeps the height it has with its
 * words, so nothing shifts when they arrive. When the page was seen before,
 * the screen draws the real cards with their words held back instead, from
 * what the last visit knew.
 */
export function InboxLoading(): JSX.Element {
  return (
    <>
      <p className="inbox-sr" role="status">
        Loading the Inbox
      </p>
      <div className="inbox-wide" aria-hidden="true">
        <div className="inbox-section-head">
          <SectionHeading name="Ongoing" count={0} />
        </div>
        {LOADING_ROWS_OF_PLACES.map((rows, place) => (
          <section key={place} className="inbox-place">
            <i className="card-stock" />
            <header className="inbox-place-head is-plain">
              <i className="loading-bar loading-bar--place" />
            </header>
            <div className="inbox-place-rows">
              {Array.from({ length: rows }, (_, row) => (
                <div key={row} className="inbox-row">
                  <span className="row-rail" />
                  <span className="row-main">
                    <i className="loading-bar loading-bar--title" />
                    <span className="row-context">
                      <i className="loading-bar loading-bar--line" />
                    </span>
                  </span>
                  <span className="row-end" />
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
      <aside className="inbox-narrow" aria-hidden="true">
        <div className="inbox-section-head">
          <SectionHeading name="Requests" count={0} />
        </div>
        <div className="inbox-requests">
          <div className="inbox-requests-group">
            {Array.from({ length: LOADING_REQUESTS }, (_, request) => (
              <div key={request} className="inbox-request">
                <i className="card-stock" />
                <span className="card-body">
                  <span className="request-mark" />
                  <p className="request-title">
                    <i className="loading-bar loading-bar--title" />
                  </p>
                  <span className="request-under">
                    <i className="loading-bar loading-bar--line" />
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>
      </aside>
    </>
  );
}
