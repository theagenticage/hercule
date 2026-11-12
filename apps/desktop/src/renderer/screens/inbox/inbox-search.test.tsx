/** Tests the Inbox search field: tokens, the scope token, the suggestions menu, and the keys that leave it. */
import { createRef, useState, type JSX } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_INBOX_SEARCH,
  type InboxClause,
  type InboxField,
  type InboxSearch,
  type InboxSearchContext,
} from "@hercule/client-core/inbox";
import { InboxSearchField, type InboxSearchHandle } from "./inbox-search";

const FIELDS: InboxField[] = [
  { key: "team", label: "Team", type: "enum", source: "linear" },
  { key: "project", label: "Project", type: "text", source: "linear" },
  { key: "events", label: "Events", type: "number", source: "sentry" },
  { key: "waiting", label: "Waiting", type: "age" },
  { key: "from", label: "From", type: "person" },
];

const CONTEXT: InboxSearchContext = {
  fields: FIELDS,
  suggestedValues: {
    team: [
      { value: "Payments", count: 3 },
      { value: "Checkout", count: 9 },
    ],
    project: [{ value: "Checkout revamp", count: 4 }],
  },
};

const is = (key: string, value: string): InboxClause => ({ key, op: "is", value });

/** Renders the field over its own state, like the orchestrator that owns it, and returns what it called. */
const renderField = (
  options: {
    readonly start?: InboxSearch;
    readonly scopeIsEverything?: boolean;
  } = {},
) => {
  const calls = {
    onWiden: vi.fn<() => void>(),
    onLeaveToResults: vi.fn<() => void>(),
    onLeave: vi.fn<() => void>(),
    onOpenClauseChange: vi.fn<(key: string | null, typed: string) => void>(),
    latest: { current: options.start ?? EMPTY_INBOX_SEARCH },
  };
  const handle = createRef<InboxSearchHandle>();
  function Harness(): JSX.Element {
    const [search, setSearch] = useState(options.start ?? EMPTY_INBOX_SEARCH);
    return (
      <InboxSearchField
        ref={handle}
        search={search}
        context={CONTEXT}
        scopeTitle="Someone waits on me"
        scopeIsEverything={options.scopeIsEverything ?? false}
        plugins={[]}
        resultsText="3 things match in Someone waits on me."
        onChange={(next) => {
          calls.latest.current = next;
          setSearch(next);
        }}
        onOpenClauseChange={calls.onOpenClauseChange}
        onWiden={calls.onWiden}
        onLeaveToResults={calls.onLeaveToResults}
        onLeave={calls.onLeave}
      />
    );
  }
  render(<Harness />);
  return { ...calls, handle, input: screen.getByRole("combobox", { name: "Search the Inbox" }) };
};

describe("InboxSearchField", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("makes a token of a finished field and value", async () => {
    const user = userEvent.setup();
    const { input, latest } = renderField();
    await user.type(input, "team:Payments ");
    expect(screen.getByRole("button", { name: "Remove team:Payments" })).toBeTruthy();
    expect(latest.current.clauses).toEqual([is("team", "Payments")]);
  });

  it("types a value that holds spaces whole", async () => {
    const user = userEvent.setup();
    const { input } = renderField();
    await user.type(input, "project:Checkout revamp ");
    expect(screen.getByRole("button", { name: "Remove project:Checkout revamp" })).toBeTruthy();
  });

  it("removes the last token with Backspace in an empty field, and never the scope", async () => {
    const user = userEvent.setup();
    const { input, onWiden } = renderField({
      start: { ...EMPTY_INBOX_SEARCH, clauses: [is("team", "Payments")] },
    });
    await user.click(input);
    await user.keyboard("{Backspace}");
    expect(screen.queryByRole("button", { name: "Remove team:Payments" })).toBeNull();
    await user.keyboard("{Backspace}{Backspace}");
    expect(screen.getByText("Someone waits on me")).toBeTruthy();
    expect(onWiden).not.toHaveBeenCalled();
  });

  it("leads the focused field with the scope, which its × widens", async () => {
    const user = userEvent.setup();
    const { input, onWiden } = renderField();
    expect(screen.queryByText("Someone waits on me")).toBeNull();
    await user.click(input);
    await user.click(screen.getByRole("button", { name: "Search Everything instead" }));
    expect(onWiden).toHaveBeenCalledOnce();
  });

  it("shows no scope token when the scope is Everything", async () => {
    const user = userEvent.setup();
    const { input } = renderField({ scopeIsEverything: true });
    await user.click(input);
    expect(screen.queryByText("Someone waits on me")).toBeNull();
  });

  it("folds the tokens that do not fit into a +N token that lists them", () => {
    // Each visible child of the tokens' row is 100px wide, and the row has 250px.
    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(250);
    vi.spyOn(Element.prototype, "scrollWidth", "get").mockImplementation(function (this: Element) {
      return [...this.children].filter((child) => !(child as HTMLElement).hidden).length * 100;
    });
    renderField({
      scopeIsEverything: true,
      start: {
        ...EMPTY_INBOX_SEARCH,
        clauses: [is("team", "A"), is("team", "B"), is("team", "C")],
      },
    });
    const more = screen.getByText("+2");
    expect(more.getAttribute("title")).toBe("team:A, team:B");
    expect(screen.queryByRole("button", { name: "Remove team:A" })).toBeNull();
    expect(screen.getByRole("button", { name: "Remove team:C" })).toBeTruthy();
  });

  it("shows the longest placeholder that fits whole", () => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.classList.contains("ib-sx-probe") ? (this.textContent ?? "").length * 8 : 0;
    });
    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(300);
    const { input } = renderField();
    expect(input.getAttribute("placeholder")).toBe("Search, or type team:, from:");
  });

  it("is a combobox that points at the highlighted option", async () => {
    const user = userEvent.setup();
    const { input } = renderField();
    expect(input.getAttribute("aria-expanded")).toBe("false");
    await user.type(input, "te");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    const options = screen.getAllByRole("option", { hidden: true });
    expect(options[0]!.getAttribute("aria-selected")).toBe("true");
    expect(options[1]!.getAttribute("aria-selected")).toBe("false");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0]!.id);
    expect(within(options[0]!).getByText("in titles and fields")).toBeTruthy();
  });

  it("highlights nothing in an empty field", async () => {
    const user = userEvent.setup();
    const { input } = renderField();
    await user.click(input);
    expect(screen.getByText("Search by a field")).toBeTruthy();
    for (const option of screen.getAllByRole("option", { hidden: true })) {
      expect(option.getAttribute("aria-selected")).toBe("false");
    }
    expect(input.getAttribute("aria-activedescendant")).toBeNull();
  });

  it("adds the highlighted value with Return, and stays in the field", async () => {
    const user = userEvent.setup();
    const { input, latest, onLeaveToResults } = renderField();
    await user.type(input, "team:");
    expect(
      screen.getAllByRole("option", { hidden: true }).map((option) => option.textContent),
    ).toEqual(["team:Checkout9", "team:Payments3"]);
    await user.keyboard("{Enter}");
    expect(latest.current.clauses).toEqual([is("team", "Checkout")]);
    expect(onLeaveToResults).not.toHaveBeenCalled();
  });

  it("tells the caller which clause is being typed, so it can read its values", async () => {
    const user = userEvent.setup();
    const { input, onOpenClauseChange } = renderField();
    await user.type(input, "team:Pa");
    expect(onOpenClauseChange).toHaveBeenLastCalledWith("team", "Pa");
  });

  it("goes to the results with ↓ past the last suggestion and with Return on free text", async () => {
    const user = userEvent.setup();
    const { input, onLeaveToResults } = renderField();
    await user.type(input, "login");
    // Only the free-text row is offered, so ↓ is past the last one.
    await user.keyboard("{ArrowDown}");
    expect(onLeaveToResults).toHaveBeenCalledOnce();
    await user.click(input);
    await user.keyboard("{Enter}");
    expect(onLeaveToResults).toHaveBeenCalledTimes(2);
  });

  it("leaves with Esc and keeps the search", async () => {
    const user = userEvent.setup();
    const { input, onLeave, latest } = renderField();
    await user.type(input, "login");
    await user.keyboard("{Escape}");
    expect(onLeave).toHaveBeenCalledOnce();
    expect(latest.current.text).toBe("login");
    expect(input.getAttribute("aria-expanded")).toBe("false");
  });

  it("takes what Return would when the field is left by Tab or a click elsewhere", async () => {
    const user = userEvent.setup();
    const { input, latest } = renderField();
    await user.type(input, "team:Check");
    await user.click(document.body);
    expect(latest.current.clauses).toEqual([is("team", "Checkout")]);

    await user.click(input);
    await user.type(input, "team:Pay");
    await user.tab();
    expect(latest.current.clauses).toEqual([is("team", "Checkout"), is("team", "Payments")]);
  });

  it("takes the focus when asked to through its ref", () => {
    const { input, handle } = renderField();
    handle.current!.focus();
    expect(document.activeElement).toBe(input);
  });

  it("speaks the result count through a live region", () => {
    renderField();
    expect(screen.getByRole("status").textContent).toBe("3 things match in Someone waits on me.");
  });
});
