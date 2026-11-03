/**
 * Tests that every save of one machine reaches the controller in the order
 * the user made it, whichever control made it: Stop new work, Allow, and the
 * settings rows. A stub controller holds the first answer, so a test can see
 * what is sent while an earlier save is still on its way.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { createClient } from "@hercule/client-core";
import type { MachineNeed } from "@hercule/client-core/fleet";
import type { Runner } from "@hercule/contract";
import { runnersQuery } from "../../../../app/queries";
import { createQueryClient } from "../../../../app/query-client";
import {
  buildErrorBody,
  CONTROLLER_URL,
  SIDEBAR_FIXTURE,
  stubApi,
  type Call,
  type Handler,
} from "../../../../app/testing";
import { AllowSessionsButton } from "./-allow-sessions-button";
import { useSavedRunnerDrain, useSavedRunnerField } from "./-saved-runner-field";

const route = vi.hoisted(() => ({ client: undefined as unknown }));

// The Allow button reads its client from the route's context, which these
// tests do not render a router for.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useRouteContext: () => ({ controller: { client: route.client } }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const [BASE] = SIDEBAR_FIXTURE.runners;
const ATLAS: Runner = { ...BASE!, id: "01a06d02-0000-7000-8000-00000000a710", name: "atlas" };
const MOSS: Runner = { ...BASE!, id: "01a06d02-0000-7000-8000-00000000b055", name: "moss" };

/** A runner as the controller returns it from an operation on one runner. */
const asDetail = (runner: Runner) => ({
  ...runner,
  negotiatedCapabilities: null,
  protocolVersion: null,
});

/** A request the stub controller holds until the test lets it go. */
const buildGate = () => {
  let release = () => {};
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    opened,
    open: () => {
      act(() => {
        release();
      });
    },
  };
};

/**
 * Stubs a controller that holds `ATLAS` and `MOSS`. `firstOf` names the
 * request, as "METHOD path", that waits for its gate before it answers; every
 * other request answers at once. The runner a request returns has the
 * lifecycle and cap the request set.
 */
const stubController = (firstOf: string, gate: ReturnType<typeof buildGate>) => {
  const held: Record<string, Runner> = { [ATLAS.id]: ATLAS, [MOSS.id]: MOSS };
  const answer =
    (change: (call: Call) => Partial<Runner>, id: string): Handler =>
    async (call) => {
      if (`${call.method} ${call.path}` === firstOf) await gate.opened;
      held[id] = { ...held[id]!, ...change(call) };
      return { body: asDetail(held[id]) };
    };
  const handlers: Record<string, Handler> = {
    "GET /api/v1/runners": () => ({ body: { items: Object.values(held) } }),
  };
  for (const { id } of [ATLAS, MOSS]) {
    handlers[`POST /api/v1/runners/${id}/drain`] = answer(() => ({ lifecycle: "draining" }), id);
    handlers[`POST /api/v1/runners/${id}/undrain`] = answer(() => ({ lifecycle: "active" }), id);
    handlers[`PATCH /api/v1/runners/${id}`] = answer((call) => call.body as Partial<Runner>, id);
  }
  const calls = stubApi(handlers);
  return { calls, held };
};

/** Returns "METHOD path" of each write in `calls`, with the runner's id cut to its name. */
const readWrites = (calls: readonly Call[]): readonly string[] =>
  calls
    .filter((call) => call.method !== "GET")
    .map((call) =>
      `${call.method} ${call.path}`
        .replace(ATLAS.id, "atlas")
        .replace(MOSS.id, "moss")
        .replace("/api/v1/runners/", ""),
    );

/** Returns a query client whose cached runners are ATLAS and MOSS, the client of a controller, and a wrapper that provides them. */
const setUpRunners = () => {
  const queryClient = createQueryClient();
  const client = createClient({ baseUrl: CONTROLLER_URL, token: "bearer" });
  route.client = client;
  queryClient.setQueryData(runnersQuery(client).queryKey, [ATLAS, MOSS]);
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, client, wrapper };
};

/** Returns the need of a machine with sessions waiting, whose Allow sets the cap to `cap`. */
const buildWaitingNeed = (cap: number): Extract<MachineNeed, { kind: "waiting" }> => ({
  kind: "waiting",
  hue: "you",
  line: "5 threads wait for a slot",
  allow: cap,
  allowHint: `Lets ${String(cap)} sessions run here at once.`,
});

/** Returns the settings row for the session cap of ATLAS, which saves like the machine page's. */
const useCapRow = (client: ReturnType<typeof createClient>) =>
  useSavedRunnerField(
    client,
    ATLAS.id,
    ATLAS.maxConcurrentSessions,
    (_value, change: number) => change,
    (_latest, change) => ({ maxConcurrentSessions: change }),
  );

describe("the saves of one machine", () => {
  it("sends Stop new work switched on and straight off again in that order", async () => {
    const gate = buildGate();
    const { calls, held } = stubController(`POST /api/v1/runners/${ATLAS.id}/drain`, gate);
    const { queryClient, client, wrapper } = setUpRunners();
    const { result } = renderHook(() => useSavedRunnerDrain(client, ATLAS), { wrapper });

    act(() => {
      result.current.save(true);
      result.current.save(false);
    });
    await waitFor(() => {
      expect(readWrites(calls)).toEqual(["POST atlas/drain"]);
    });
    // The undrain waits for the drain, so it cannot overtake it.
    expect(readWrites(calls)).not.toContain("POST atlas/undrain");

    gate.open();
    await waitFor(() => {
      expect(readWrites(calls)).toEqual(["POST atlas/drain", "POST atlas/undrain"]);
    });
    await waitFor(() => {
      expect(held[ATLAS.id]?.lifecycle).toBe("active");
      expect(
        queryClient.getQueryData(runnersQuery(client).queryKey)?.find((r) => r.id === ATLAS.id)
          ?.lifecycle,
      ).toBe("active");
    });
  });

  it("sends an Allow and then an edit of the cap of the same machine in that order", async () => {
    const user = userEvent.setup();
    const gate = buildGate();
    const { calls } = stubController(`PATCH /api/v1/runners/${ATLAS.id}`, gate);
    const { client, wrapper } = setUpRunners();
    const cap = renderHook(() => useCapRow(client), { wrapper });
    render(<AllowSessionsButton runnerId={ATLAS.id} need={buildWaitingNeed(20)} />, { wrapper });

    await user.click(screen.getByRole("button", { name: "Allow 20" }));
    await waitFor(() => {
      expect(readWrites(calls)).toEqual(["PATCH atlas"]);
    });
    act(() => {
      cap.result.current.save(3);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(readWrites(calls)).toEqual(["PATCH atlas"]);

    gate.open();
    await waitFor(() => {
      expect(calls.filter((call) => call.method === "PATCH").map((call) => call.body)).toEqual([
        { maxConcurrentSessions: 20 },
        { maxConcurrentSessions: 3 },
      ]);
    });
  });

  it("keeps an Allow ahead of an edit made after the user left the page", async () => {
    const user = userEvent.setup();
    const gate = buildGate();
    const { calls } = stubController(`PATCH /api/v1/runners/${ATLAS.id}`, gate);
    const { client, wrapper } = setUpRunners();
    const first = render(<AllowSessionsButton runnerId={ATLAS.id} need={buildWaitingNeed(20)} />, {
      wrapper,
    });
    await user.click(screen.getByRole("button", { name: "Allow 20" }));
    await waitFor(() => {
      expect(readWrites(calls)).toEqual(["PATCH atlas"]);
    });
    first.unmount();

    // The page comes back, on the same query client, with the Allow still saving.
    const cap = renderHook(() => useCapRow(client), { wrapper });
    act(() => {
      cap.result.current.save(3);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(readWrites(calls)).toEqual(["PATCH atlas"]);

    gate.open();
    await waitFor(() => {
      expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(2);
    });
  });

  it("shows an Allow that is still saving on a button drawn anew, and ignores presses meanwhile", async () => {
    const user = userEvent.setup();
    const gate = buildGate();
    const { calls } = stubController(`PATCH /api/v1/runners/${ATLAS.id}`, gate);
    const { wrapper } = setUpRunners();
    const first = render(<AllowSessionsButton runnerId={ATLAS.id} need={buildWaitingNeed(20)} />, {
      wrapper,
    });
    await user.click(screen.getByRole("button", { name: "Allow 20" }));
    await waitFor(() => {
      expect(readWrites(calls)).toEqual(["PATCH atlas"]);
    });
    // The Grid and List views draw their own buttons, so a switch draws a new one.
    first.unmount();
    render(<AllowSessionsButton runnerId={ATLAS.id} need={buildWaitingNeed(20)} />, { wrapper });

    const saving = await screen.findByRole("button", { name: "Saving…" });
    expect(saving.getAttribute("aria-disabled")).toBe("true");
    await user.click(saving);
    expect(readWrites(calls)).toEqual(["PATCH atlas"]);

    gate.open();
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Saving…" })).toBeNull();
    });
  });

  it("does not make one machine wait for another", async () => {
    const user = userEvent.setup();
    const gate = buildGate();
    const { calls } = stubController(`PATCH /api/v1/runners/${ATLAS.id}`, gate);
    const { wrapper } = setUpRunners();
    render(
      <>
        <AllowSessionsButton runnerId={ATLAS.id} need={buildWaitingNeed(20)} />
        <AllowSessionsButton runnerId={MOSS.id} need={buildWaitingNeed(5)} />
      </>,
      { wrapper },
    );

    await user.click(screen.getByRole("button", { name: "Allow 20" }));
    await user.click(screen.getByRole("button", { name: "Allow 5" }));

    await waitFor(() => {
      expect(readWrites(calls)).toEqual(["PATCH atlas", "PATCH moss"]);
    });
    gate.open();
  });

  it("says why an Allow failed, and leaves the button to try again", async () => {
    const user = userEvent.setup();
    stubApi({
      [`PATCH /api/v1/runners/${ATLAS.id}`]: {
        status: 409,
        body: buildErrorBody("conflict", "The runner is being retired."),
      },
    });
    const { wrapper } = setUpRunners();
    render(<AllowSessionsButton runnerId={ATLAS.id} need={buildWaitingNeed(17)} />, { wrapper });

    await user.click(screen.getByRole("button", { name: "Allow 17" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not allow 17 sessions: The runner is being retired.",
    );
    expect(screen.getByRole("button", { name: "Allow 17" })).toBeTruthy();
  });

  describe("an Allow that is refused", () => {
    const REFUSED = {
      status: 409,
      body: buildErrorBody("conflict", "The runner is being retired."),
    };

    /** Stubs a controller that refuses the first Allow only after its gate opens, and accepts later ones at once. */
    const stubRefusalAfterGate = (gate: ReturnType<typeof buildGate>) => {
      let attempts = 0;
      return stubApi({
        "GET /api/v1/runners": () => ({ body: { items: [ATLAS, MOSS] } }),
        [`PATCH /api/v1/runners/${ATLAS.id}`]: async () => {
          attempts += 1;
          if (attempts > 1) return { body: asDetail(ATLAS) };
          await gate.opened;
          return REFUSED;
        },
      });
    };

    it("shows the refusal, with the cap that was asked for, on a button drawn anew while the Allow was saving", async () => {
      const user = userEvent.setup();
      const gate = buildGate();
      const calls = stubRefusalAfterGate(gate);
      const { wrapper } = setUpRunners();
      const first = render(
        <AllowSessionsButton runnerId={ATLAS.id} need={buildWaitingNeed(17)} />,
        { wrapper },
      );
      await user.click(screen.getByRole("button", { name: "Allow 17" }));
      await waitFor(() => {
        expect(readWrites(calls)).toEqual(["PATCH atlas"]);
      });
      first.unmount();
      // The cap that waits has moved on by the time the new button is drawn.
      render(<AllowSessionsButton runnerId={ATLAS.id} need={buildWaitingNeed(19)} />, { wrapper });
      await screen.findByRole("button", { name: "Saving…" });

      gate.open();

      expect((await screen.findByRole("alert")).textContent).toBe(
        "Could not allow 17 sessions: The runner is being retired.",
      );
      expect(screen.getByRole("button", { name: "Allow 19" })).toBeTruthy();
    });

    it("stays shown on a button drawn anew after the refusal", async () => {
      const user = userEvent.setup();
      const gate = buildGate();
      stubRefusalAfterGate(gate);
      gate.open();
      const { wrapper } = setUpRunners();
      const first = render(
        <AllowSessionsButton runnerId={ATLAS.id} need={buildWaitingNeed(17)} />,
        { wrapper },
      );
      await user.click(screen.getByRole("button", { name: "Allow 17" }));
      await screen.findByRole("alert");

      first.unmount();
      render(<AllowSessionsButton runnerId={ATLAS.id} need={buildWaitingNeed(17)} />, { wrapper });

      expect((await screen.findByRole("alert")).textContent).toBe(
        "Could not allow 17 sessions: The runner is being retired.",
      );
    });

    it("is replaced by the next Allow", async () => {
      const user = userEvent.setup();
      const gate = buildGate();
      stubRefusalAfterGate(gate);
      gate.open();
      const { wrapper } = setUpRunners();
      render(<AllowSessionsButton runnerId={ATLAS.id} need={buildWaitingNeed(17)} />, { wrapper });
      await user.click(screen.getByRole("button", { name: "Allow 17" }));
      await screen.findByRole("alert");

      await user.click(screen.getByRole("button", { name: "Allow 17" }));

      await waitFor(() => {
        expect(screen.queryByRole("alert")).toBeNull();
      });
    });
  });
});
