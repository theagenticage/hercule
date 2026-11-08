/** Tests how the page's stops are read from the DOM, with cards inside bundles that hold parts and hints. */
import type { JSX, ReactNode } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CARD_SELECTOR, readCardId, readInboxStops } from "./inbox-page-dom";

const Row = ({
  id,
  hasTask,
  children,
}: {
  id: string;
  hasTask?: boolean;
  children?: ReactNode;
}): JSX.Element => (
  <div className="inbox-bundle">
    <div
      className="inbox-row"
      data-card-id={id}
      data-has-task={hasTask === true ? "" : undefined}
    />
    {children}
  </div>
);
const Request = ({ id, children }: { id: string; children?: ReactNode }): JSX.Element => (
  <div className="inbox-bundle">
    <div className="inbox-request" data-card-id={id} />
    {children}
  </div>
);
const AskingPart = ({ id }: { id: string }): JSX.Element => (
  <div className="inbox-part is-asking" data-card-id={id} />
);
const QuietPart = (): JSX.Element => <div className="inbox-part is-quiet" data-open-id="x" />;
const Hint = (): JSX.Element => (
  <button className="inbox-hint" data-link-from="a" data-link-to="b" />
);

const followedBy = (page: HTMLElement): Record<string, string | undefined> =>
  Object.fromEntries(readInboxStops(page).map((stop) => [stop.id, stop.followedBy]));

describe("readInboxStops", () => {
  it("follows a row with the row of the next bundle, whatever the first bundle holds under its row", () => {
    const { container } = render(
      <div className="inbox-wide">
        <div role="list">
          <Row id="1">
            <div className="inbox-tucked">
              <AskingPart id="p" />
              <QuietPart />
            </div>
            <Hint />
          </Row>
          <Row id="2" />
          <Row id="3" />
        </div>
      </div>,
    );
    expect(followedBy(container)).toEqual({ "1": "2", p: undefined, "2": "3", "3": undefined });
  });

  it("lists a part right after its lead, in the page's order, as a stop of the wide side", () => {
    const { container } = render(
      <>
        <div className="inbox-wide">
          <Row id="1">
            <div className="inbox-tucked">
              <AskingPart id="p" />
            </div>
          </Row>
          <Row id="2" />
        </div>
        <aside className="inbox-narrow">
          <Request id="r" />
        </aside>
      </>,
    );
    expect(readInboxStops(container).map((stop) => [stop.id, stop.column])).toEqual([
      ["1", "wide"],
      ["p", "wide"],
      ["2", "wide"],
      ["r", "narrow"],
    ]);
  });

  it("follows a request with the request of the next bundle, and nothing across a pointer row or a heading", () => {
    const { container } = render(
      <>
        <aside className="inbox-narrow">
          <div className="inbox-requests-group">
            <Request id="1">
              <Hint />
            </Request>
            <Request id="2" />
          </div>
          <h3>Label</h3>
          <div className="inbox-requests-group">
            <Request id="3" />
          </div>
        </aside>
        <div className="inbox-wide">
          <Row id="a" />
          <div className="inbox-pointer" data-pointer-to="a" />
          <Row id="b" />
        </div>
      </>,
    );
    expect(followedBy(container)).toEqual({
      "1": "2",
      "2": undefined,
      "3": undefined,
      a: undefined,
      b: undefined,
    });
  });

  it("never follows a part: its neighbour closes up under it and does not rise into its place", () => {
    const { container } = render(
      <Row id="1">
        <div className="inbox-tucked">
          <AskingPart id="p" />
          <AskingPart id="q" />
        </div>
      </Row>,
    );
    expect(followedBy(container)).toEqual({ "1": undefined, p: undefined, q: undefined });
  });

  it("marks a card a Task holds as one that no longer waits", () => {
    const { container } = render(<Row id="1" hasTask />);
    expect(readInboxStops(container)[0]?.waits).toBe(false);
  });
});

describe("the elements a click reads as a card", () => {
  it("reads a row and a part that asks as cards, and a quiet part or a hint as none", () => {
    const { container } = render(
      <Row id="1">
        <div className="inbox-tucked">
          <AskingPart id="p" />
          <QuietPart />
        </div>
        <Hint />
      </Row>,
    );
    expect(container.querySelectorAll(CARD_SELECTOR)).toHaveLength(2);
    expect(readCardId(container.querySelector(".is-asking"))).toBe("p");
    expect(readCardId(container.querySelector(".is-quiet"))).toBeNull();
    expect(readCardId(container.querySelector(".inbox-hint"))).toBeNull();
  });
});
