/**
 * Tests that the picker of MCP Servers reports each click as a choice, not as
 * the whole list it has drawn: the list it draws can be older than the list
 * the caller holds, and the caller resolves the choice against its own list.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
    readonly onChoose: Parameters<typeof McpServerPicker>[0]["onChoose"];
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
  it("reports a click on a name as the choice of that name, with the account the row showed", async () => {
    const user = userEvent.setup();
    const onChoose = vi.fn();
    renderPicker({ onChoose });

    await user.click(screen.getByRole("checkbox", { name: "linear" }));

    expect(onChoose).toHaveBeenCalledExactlyOnceWith({
      kind: "name",
      name: "linear",
      serverId: LINEAR.id,
      shownServerId: LINEAR.id,
    });
  });

  it("reports a swap of account with the account the row showed before it", async () => {
    const user = userEvent.setup();
    const onChoose = vi.fn();
    renderPicker({ onChoose });

    await user.selectOptions(screen.getByRole("combobox", { name: "Account of sentry" }), "hobby");

    expect(onChoose).toHaveBeenCalledExactlyOnceWith({
      kind: "name",
      name: "sentry",
      serverId: SENTRY_HOBBY.id,
      shownServerId: SENTRY_WORK.id,
    });
  });

  it("reports the way back to the start list as a choice, for the caller to resolve when the button is pressed", async () => {
    const user = userEvent.setup();
    const onChoose = vi.fn();
    renderPicker({ onChoose, reset: { label: "Back to the default list" } });

    expect(onChoose).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Back to the default list" }));

    expect(onChoose).toHaveBeenCalledExactlyOnceWith({ kind: "reset" });
  });
});
