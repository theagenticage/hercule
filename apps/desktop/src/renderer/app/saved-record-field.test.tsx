/**
 * Tests `useSavedRecordField` with a plain list of records: what the control
 * shows while a save runs, what a failed save leaves, and the order of saves.
 * The assistant settings test the hook again through the real screen.
 */
import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, queryOptions } from "@tanstack/react-query";
import { useSavedRecordField } from "./saved-record-field";

interface Note {
  readonly id: string;
  readonly text: string;
}

const LIST_KEY = queryOptions({
  queryKey: ["notes"],
  queryFn: (): Promise<ReadonlyArray<Note>> => Promise.resolve([]),
}).queryKey;

/** A save that waits until the test settles it. */
interface HeldSave {
  readonly payload: { readonly text: string };
  readonly succeed: () => void;
  readonly fail: (message: string) => void;
}

/**
 * Renders the hook for the note `n-1` of a cached list, with an `update` that
 * holds every save until the test settles it. Returns the held saves in the
 * order they were sent.
 */
const renderNoteField = () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(LIST_KEY, [{ id: "n-1", text: "first" }]);
  const sent: HeldSave[] = [];
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const rendered = renderHook(
    () =>
      useSavedRecordField({
        listKey: LIST_KEY,
        recordKind: "note",
        id: "n-1",
        stored: queryClient.getQueryData(LIST_KEY)?.[0]?.text ?? "",
        applyChange: (_value, change: string) => change,
        buildPayload: (_latest, change) => ({ text: change }),
        update: (id, payload) =>
          new Promise<Note>((resolve, reject) => {
            sent.push({
              payload,
              succeed: () => resolve({ id, text: payload.text }),
              fail: (message) => reject(new Error(message)),
            });
          }),
      }),
    { wrapper },
  );
  return { ...rendered, sent };
};

describe("useSavedRecordField", () => {
  it("shows the value being saved while the save runs, and the saved value after", async () => {
    const { result, sent } = renderNoteField();
    act(() => result.current.save("second"));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(result.current.value).toBe("second");

    act(() => sent[0]?.succeed());
    await waitFor(() => expect(result.current.value).toBe("second"));
    expect(result.current.error).toBeNull();
  });

  it("puts the control back to the saved value and returns the error when a save fails", async () => {
    const { result, sent } = renderNoteField();
    act(() => result.current.save("second"));
    await waitFor(() => expect(sent).toHaveLength(1));

    act(() => sent[0]?.fail("The database is locked."));
    await waitFor(() =>
      expect(result.current.error).toBe("Could not save: The database is locked."),
    );
    expect(result.current.value).toBe("first");
  });

  it("sends the saves of one record one after another, in the order they were made", async () => {
    const { result, sent } = renderNoteField();
    act(() => result.current.save("second"));
    act(() => result.current.save("third"));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(result.current.value).toBe("third");
    expect(sent[0]?.payload).toEqual({ text: "second" });

    act(() => sent[0]?.succeed());
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]?.payload).toEqual({ text: "third" });
  });
});
