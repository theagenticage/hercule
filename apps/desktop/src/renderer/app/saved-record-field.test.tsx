/**
 * Tests `useSavedRecordField` with a plain list of records: what the control
 * shows while a save runs, what a failed save leaves, the order of saves,
 * what a payload is built on, and what the list holds after a save.
 * The assistant settings test the hook again through the real screen.
 */
import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider, QueryObserver, queryOptions } from "@tanstack/react-query";
import { createQueryClient } from "./query-client";
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
  readonly payload: { readonly text: string; readonly after: string };
  readonly succeed: () => void;
  readonly fail: (message: string) => void;
}

/**
 * Renders the hook for the note `n-1` of a cached list, with an `update` that
 * holds every save until the test settles it. Each payload carries the text
 * of the note it was built on, as `after`. Returns the held saves in the
 * order they were sent. `readLatest` is passed to the hook as it is.
 */
const renderNoteField = (readLatest?: (id: string) => Promise<Note>) => {
  // The app's own client, whose `gcTime` of 0 drops a failed mutation nothing observes.
  const queryClient = createQueryClient();
  queryClient.setQueryData(LIST_KEY, [{ id: "n-1", text: "first" }]);
  const sent: HeldSave[] = [];
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const rendered = renderHook(
    () =>
      useSavedRecordField<Note, string, string, HeldSave["payload"]>({
        listKey: LIST_KEY,
        id: "n-1",
        stored: queryClient.getQueryData(LIST_KEY)?.[0]?.text ?? "",
        applyChange: (_value, change) => change,
        buildPayload: (latest, change) => ({ text: change, after: latest.text }),
        ...(readLatest === undefined ? {} : { readLatest }),
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
  return { ...rendered, queryClient, sent };
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
    expect(sent[0]?.payload).toEqual({ text: "second", after: "first" });

    act(() => sent[0]?.succeed());
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]?.payload).toEqual({ text: "third", after: "second" });
  });

  it("shows the error of a failed save while a save queued behind it runs and succeeds", async () => {
    const { result, sent } = renderNoteField();
    act(() => result.current.save("second"));
    act(() => result.current.save("third"));
    await waitFor(() => expect(sent).toHaveLength(1));

    act(() => sent[0]?.fail("The database is locked."));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(result.current.error).toBe("Could not save: The database is locked.");
    expect(result.current.failedChange).toBe("second");
    expect(result.current.value).toBe("third");

    act(() => sent[1]?.succeed());
    await waitFor(() => expect(result.current.value).toBe("third"));
    expect(result.current.error).toBe("Could not save: The database is locked.");
    expect(result.current.failedChange).toBe("second");
  });

  it("clears the error of a failed save when the next save is made", async () => {
    const { result, sent } = renderNoteField();
    act(() => result.current.save("second"));
    await waitFor(() => expect(sent).toHaveLength(1));
    act(() => sent[0]?.fail("The database is locked."));
    await waitFor(() => expect(result.current.error).not.toBeNull());

    act(() => result.current.save("third"));

    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.failedChange).toBeNull();
  });

  it("reads the list again after a save, so an older answer does not replace a newer record", async () => {
    const { result, queryClient, sent } = renderNoteField();
    let stored: ReadonlyArray<Note> = [{ id: "n-1", text: "first" }];
    // A screen that shows the list keeps it active, so invalidating it reads it again.
    const unsubscribe = new QueryObserver(queryClient, {
      queryKey: LIST_KEY,
      queryFn: () => Promise.resolve(stored),
      staleTime: Infinity,
    }).subscribe(() => undefined);
    act(() => result.current.save("second"));
    await waitFor(() => expect(sent).toHaveLength(1));
    // Another writer changes the note after the save is stored, and a live
    // update brings that change into the cache before the save answers.
    stored = [{ id: "n-1", text: "changed elsewhere" }];
    queryClient.setQueryData(LIST_KEY, stored);

    act(() => sent[0]?.succeed());

    await waitFor(() => expect(queryClient.isMutating()).toBe(0));
    expect(queryClient.getQueryData(LIST_KEY)).toEqual([{ id: "n-1", text: "changed elsewhere" }]);
    unsubscribe();
  });

  it("builds a payload on the record as the controller has it when `readLatest` is given", async () => {
    const { result, sent } = renderNoteField(() =>
      Promise.resolve({ id: "n-1", text: "changed elsewhere" }),
    );
    act(() => result.current.save("second"));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.payload).toEqual({ text: "second", after: "changed elsewhere" });
  });

  it("saves nothing for a record that is gone from the list, without reading it", async () => {
    const reads: string[] = [];
    const { result, queryClient, sent } = renderNoteField((id) => {
      reads.push(id);
      return Promise.resolve({ id, text: "first" });
    });
    queryClient.setQueryData(LIST_KEY, []);

    act(() => result.current.save("second"));

    await waitFor(() => expect(result.current.value).toBe("first"));
    expect(sent).toHaveLength(0);
    expect(reads).toEqual([]);
  });
});
