/**
 * Tests that every save of one machine reaches the controller in the order
 * the user made it, whichever control made it: Stop new work, Allow, and the
 * settings rows. A stub controller holds the first answer, so a test can see
 * what is sent while an earlier save is still on its way.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createClient } from "@hercule/client-core";
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
import { useAllowSessions } from "./-allow-sessions";
import { useSavedRunnerDrain, useSavedRunnerField } from "./-saved-runner-field";

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

/** Renders `useHooks` under a query client whose cached runners are ATLAS and MOSS. */
const renderWithRunners = <Result,>(
  useHooks: (client: ReturnType<typeof createClient>) => Result,
) => {
  const queryClient = createQueryClient();
  const client = createClient({ baseUrl: CONTROLLER_URL, token: "bearer" });
  queryClient.setQueryData(runnersQuery(client).queryKey, [ATLAS, MOSS]);
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { ...renderHook(() => useHooks(client), { wrapper }), queryClient, client, wrapper };
};

describe("the saves of one machine", () => {
  it("sends Stop new work switched on and straight off again in that order", async () => {
    const gate = buildGate();
    const { calls, held } = stubController(`POST /api/v1/runners/${ATLAS.id}/drain`, gate);
    const { result, queryClient, client } = renderWithRunners((c) => useSavedRunnerDrain(c, ATLAS));

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
    const gate = buildGate();
    const { calls } = stubController(`PATCH /api/v1/runners/${ATLAS.id}`, gate);
    const { result } = renderWithRunners((client) => ({
      allow: useAllowSessions(client),
      cap: useSavedRunnerField(
        client,
        ATLAS.id,
        ATLAS.maxConcurrentSessions,
        (_value, change: number) => change,
        (_latest, change) => ({ maxConcurrentSessions: change }),
      ),
    }));

    act(() => {
      result.current.allow.allow(ATLAS.id, 20);
    });
    await waitFor(() => {
      expect(readWrites(calls)).toEqual(["PATCH atlas"]);
    });
    act(() => {
      result.current.cap.save(3);
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
    const gate = buildGate();
    const { calls } = stubController(`PATCH /api/v1/runners/${ATLAS.id}`, gate);
    const first = renderWithRunners((client) => useAllowSessions(client));
    act(() => {
      first.result.current.allow(ATLAS.id, 20);
    });
    await waitFor(() => {
      expect(readWrites(calls)).toEqual(["PATCH atlas"]);
    });
    first.unmount();

    // The page comes back, on the same query client, with the Allow still saving.
    const second = renderHook(
      () =>
        useSavedRunnerField(
          first.client,
          ATLAS.id,
          ATLAS.maxConcurrentSessions,
          (_value, change: number) => change,
          (_latest, change) => ({ maxConcurrentSessions: change }),
        ),
      { wrapper: first.wrapper },
    );
    act(() => {
      second.result.current.save(3);
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

  it("does not make one machine wait for another", async () => {
    const gate = buildGate();
    const { calls } = stubController(`PATCH /api/v1/runners/${ATLAS.id}`, gate);
    const { result } = renderWithRunners((client) => useAllowSessions(client));

    act(() => {
      result.current.allow(ATLAS.id, 20);
      result.current.allow(MOSS.id, 5);
    });

    await waitFor(() => {
      expect(readWrites(calls)).toEqual(["PATCH atlas", "PATCH moss"]);
    });
    gate.open();
  });

  it("says which Allow failed, with the machine's name", async () => {
    stubApi({
      [`PATCH /api/v1/runners/${ATLAS.id}`]: {
        status: 409,
        body: buildErrorBody("conflict", "The runner is being retired."),
      },
    });
    const { result } = renderWithRunners((client) => useAllowSessions(client));

    act(() => {
      result.current.allow(ATLAS.id, 17);
    });

    await waitFor(() => {
      expect(result.current.failureMessage).toBe(
        "Could not allow 17 sessions on atlas: The runner is being retired.",
      );
    });
    act(() => {
      result.current.allow(MOSS.id, 5);
    });
    expect(result.current.failureMessage).toBeNull();
  });
});
