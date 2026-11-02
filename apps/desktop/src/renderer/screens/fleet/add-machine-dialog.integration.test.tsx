/**
 * Tests the Add a machine dialog against a stubbed controller: the token it
 * mints as it opens, the command with the controller's address, Copy, the
 * list of open tokens with Revoke, and a refused mint.
 */
import { StrictMode } from "react";
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { createClient, toIdTail } from "@hercule/client-core";
import type { JoinTokenRef } from "@hercule/contract";
import { createQueryClient } from "../../app/query-client";
import {
  buildErrorBody,
  CONTROLLER_URL,
  stubApi,
  stubCopyCommand,
  type Handler,
} from "../../app/testing";
import { AddMachineDialog } from "./add-machine-dialog";

const TOKENS_PATH = "/api/v1/runners/join-tokens";

const MINTED = {
  id: "01a06d02-7400-7000-8000-00000000fe5a",
  token: "hjt_fresh",
  expiresAt: "2026-11-02T15:00:00.000Z",
};
const FRESH: JoinTokenRef = {
  id: MINTED.id,
  createdAt: "2026-11-02T14:00:00.000Z",
  expiresAt: MINTED.expiresAt,
};
// Expires at the same moment as FRESH: the dialog must tell them apart by id.
const EARLIER: JoinTokenRef = {
  id: "01a06d02-7400-7000-8000-00000000ea01",
  createdAt: "2026-11-02T13:30:00.000Z",
  expiresAt: MINTED.expiresAt,
};

/**
 * Stubs a controller that holds `open` tokens, mints MINTED (adding FRESH),
 * and revokes by id, and returns the requests it received. `handlers` replace
 * its answers.
 */
const stubController = (
  open: readonly JoinTokenRef[],
  handlers: Readonly<Record<string, Handler>> = {},
) => {
  let tokens = open;
  const revoked: string[] = [];
  const calls = stubApi({
    [`GET ${TOKENS_PATH}`]: () => ({ body: tokens }),
    [`POST ${TOKENS_PATH}`]: () => {
      tokens = [...tokens, FRESH];
      return { status: 201, body: MINTED };
    },
    [`DELETE ${TOKENS_PATH}/${EARLIER.id}`]: () => {
      revoked.push(EARLIER.id);
      tokens = tokens.filter((token) => token.id !== EARLIER.id);
      return { body: {} };
    },
    [`DELETE ${TOKENS_PATH}/${FRESH.id}`]: () => {
      revoked.push(FRESH.id);
      tokens = tokens.filter((token) => token.id !== FRESH.id);
      return { body: {} };
    },
    ...handlers,
  });
  return { calls, revoked };
};

/** Renders the dialog, under React's strict mode as the app runs, and returns it. */
const renderDialog = async () => {
  const client = createClient({ baseUrl: CONTROLLER_URL, token: "bearer" });
  render(
    <StrictMode>
      <QueryClientProvider client={createQueryClient()}>
        <AddMachineDialog client={client} origin="http://atlas.test:4937" onClose={() => {}} />
      </QueryClientProvider>
    </StrictMode>,
  );
  return screen.findByRole("dialog", { name: "Add a machine" });
};

describe("the Add a machine dialog", () => {
  it("mints one token as it opens and shows the command with the controller's address", async () => {
    const { calls } = stubController([]);
    const dialog = await renderDialog();

    expect(
      await within(dialog).findByText(
        "hercule runner join http://atlas.test:4937 --token hjt_fresh",
      ),
    ).toBeTruthy();
    expect(
      calls.filter((call) => call.method === "POST" && call.path === TOKENS_PATH),
    ).toHaveLength(1);
    expect(within(dialog).getByText(/The command works once, until 2 Nov /)).toBeTruthy();
  });

  it("adds --reserved to the command for a personal machine", async () => {
    stubController([]);
    const dialog = await renderDialog();
    await within(dialog).findByText(/hjt_fresh$/);

    await userEvent.click(within(dialog).getByRole("checkbox", { name: /Personal machine/ }));

    expect(
      within(dialog).getByText(
        "hercule runner join http://atlas.test:4937 --token hjt_fresh --reserved",
      ),
    ).toBeTruthy();
  });

  it("copies the command", async () => {
    stubController([]);
    const clipboard = stubCopyCommand(true);
    const dialog = await renderDialog();
    await within(dialog).findByText(/hjt_fresh$/);

    await userEvent.click(within(dialog).getByRole("button", { name: "Copy" }));

    expect(clipboard.get("text/plain")).toBe(
      "hercule runner join http://atlas.test:4937 --token hjt_fresh",
    );
    expect(within(dialog).getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("lists the open tokens, and Revoke removes one", async () => {
    const { revoked } = stubController([EARLIER]);
    const dialog = await renderDialog();

    const list = await within(dialog).findByRole("list", { name: "Open join tokens" });
    await waitFor(() => {
      expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    });
    // The list shows ids, never a token's secret.
    expect(list.textContent).not.toContain("hjt_");
    // One of the two is the command's own token, though both expire together.
    expect(within(list).getAllByText(/^This command/)).toHaveLength(1);
    expect(within(list).getAllByText(/^Earlier token/)).toHaveLength(1);

    await userEvent.click(
      within(list).getByRole("button", { name: `Revoke token ${toIdTail(EARLIER.id)}` }),
    );
    await waitFor(() => {
      expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    });
    expect(revoked).toEqual([EARLIER.id]);
  });

  it("takes the command away when its own token is revoked", async () => {
    const { revoked } = stubController([EARLIER]);
    const dialog = await renderDialog();
    const list = await within(dialog).findByRole("list", { name: "Open join tokens" });
    await waitFor(() => {
      expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    });

    await userEvent.click(
      within(list).getByRole("button", { name: `Revoke token ${toIdTail(FRESH.id)}` }),
    );

    expect(
      await within(dialog).findByText(
        "This command's token was revoked. Close and open the dialog again for a new one.",
      ),
    ).toBeTruthy();
    expect(revoked).toEqual([FRESH.id]);
    expect(within(dialog).queryByText(/hercule runner join/)).toBeNull();
    expect(within(dialog).queryByText(/Waiting for the machine/)).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Copy" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("shows the controller's message when the mint is refused", async () => {
    stubController([], {
      [`POST ${TOKENS_PATH}`]: () => ({
        status: 500,
        body: buildErrorBody("internal", "The controller could not store the token."),
      }),
    });
    const dialog = await renderDialog();

    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "Could not make a join token: The controller could not store the token.",
    );
    expect(within(dialog).queryByText(/hercule runner join/)).toBeNull();
  });
});
