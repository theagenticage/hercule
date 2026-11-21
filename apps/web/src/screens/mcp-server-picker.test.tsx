/**
 * Tests that the picker of MCP Servers reports each click as a change of the
 * list, not as the whole list it has drawn: the list it draws can be older
 * than the list the caller holds, and the caller decides what the change is
 * applied to.
 */
import { describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  LINEAR,
  OFFERING_PLUGINS,
  SENTRY_HOBBY,
  SENTRY_WORK,
  buildViews,
} from "@hercule/client-core/mcp-servers/testing";
import { McpServerPicker } from "./mcp-server-picker";

const VIEWS = buildViews([SENTRY_WORK, SENTRY_HOBBY, LINEAR]);

const renderPicker = (
  props: Partial<Parameters<typeof McpServerPicker>[0]> & {
    readonly onChange: (update: (current: readonly string[]) => readonly string[]) => void;
  },
) =>
  render(
    <McpServerPicker
      title="MCP servers"
      views={VIEWS}
      plugins={OFFERING_PLUGINS}
      mcpServerIds={[SENTRY_WORK.id]}
      foot="The foot."
      reset={null}
      pending={false}
      failure={null}
      onClose={() => undefined}
      {...props}
    />,
  );

describe("McpServerPicker", () => {
  it("reports a click as a change to apply to the caller's list, which can differ from the one drawn", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderPicker({ onChange });

    await user.click(screen.getByRole("checkbox", { name: "linear" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const update = onChange.mock.calls[0]![0] as (current: readonly string[]) => readonly string[];
    // The picker drew [work]; the caller's list has since gained a server it never drew.
    expect(update([SENTRY_WORK.id, "s-new"])).toEqual([SENTRY_WORK.id, "s-new", LINEAR.id]);
    cleanup();
  });

  it("swaps the account of a name in the caller's list, keeping the servers it never drew", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderPicker({ onChange });

    await user.selectOptions(screen.getByRole("combobox", { name: "Account of sentry" }), "hobby");

    const update = onChange.mock.calls[0]![0] as (current: readonly string[]) => readonly string[];
    expect(update(["s-new", SENTRY_WORK.id])).toEqual(["s-new", SENTRY_HOBBY.id]);
  });

  it("leaves the list that goes back to the start list for the caller to resolve when the button is pressed", async () => {
    const user = userEvent.setup();
    const onPress = vi.fn();
    renderPicker({ onChange: vi.fn(), reset: { label: "Back to the default list", onPress } });

    expect(onPress).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Back to the default list" }));

    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
