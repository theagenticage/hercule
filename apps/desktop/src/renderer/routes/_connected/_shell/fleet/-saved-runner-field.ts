import { useMutation, useQueryClient } from "@tanstack/react-query";
import { readErrorMessage, type HerculeClient } from "@hercule/client-core";
import type { Runner, RunnerUpdateInput } from "@hercule/contract";
import { runnersQuery } from "../../../../app/queries";
import type { SavedField } from "../../../../app/saved-field";
import { useSavedRecordField } from "../../../../app/saved-record-field";

/**
 * Returns one field of the machine `runnerId`, whose control saves on every
 * change, by `useSavedRecordField`. `buildPayload` builds the `runner.update`
 * payload that applies the change to `latest`, the runner as the cache holds
 * it when the save starts; an empty payload saves nothing.
 *
 * Four fields of a machine's settings call it with the same list and update,
 * so they pass only what differs between fields. The cached list is current
 * enough to build on, because the live connection keeps it so.
 */
export function useSavedRunnerField<Value, Change>(
  client: HerculeClient,
  runnerId: string,
  stored: Value,
  applyChange: (value: Value, change: Change) => Value,
  buildPayload: (latest: Runner, change: Change) => RunnerUpdateInput,
): SavedField<Value, Change> {
  return useSavedRecordField({
    listKey: runnersQuery(client).queryKey,
    id: runnerId,
    stored,
    applyChange,
    buildPayload,
    update: (id, payload) => client.runner.update({ params: { id }, payload }),
  });
}

/**
 * Returns the Stop new work switch of a machine: `value` is true while the
 * machine is draining, and `save(true)` and `save(false)` call `runner.drain`
 * and `runner.undrain`.
 *
 * While a call runs, `value` is the state it asks for. A refused call puts
 * the switch back, and `error` says why. When a call succeeds, the runner it
 * returns replaces the cached one and the list is read again.
 */
export function useSavedRunnerDrain(
  client: HerculeClient,
  runner: Runner,
): SavedField<boolean, boolean> {
  const queryClient = useQueryClient();
  const { queryKey } = runnersQuery(client);
  const call = useMutation({
    mutationFn: (drain: boolean) =>
      drain
        ? client.runner.drain({ params: { id: runner.id } })
        : client.runner.undrain({ params: { id: runner.id } }),
    onSuccess: async (updated) => {
      queryClient.setQueryData(queryKey, (runners) =>
        runners?.map((each) => (each.id === updated.id ? updated : each)),
      );
      await queryClient.invalidateQueries({ queryKey });
    },
  });
  return {
    value: call.isPending ? call.variables : runner.lifecycle === "draining",
    error: call.isError ? `Could not save: ${readErrorMessage(call.error)}` : null,
    save: (drain) => {
      call.mutate(drain);
    },
  };
}
