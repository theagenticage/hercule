import type { HerculeClient } from "@hercule/client-core";
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
 * the switch back, and `error` says why. The calls share the mutation scope of
 * the machine's other saves (the settings rows and Allow), so they reach the
 * controller in the order the user made them: Stop new work switched on and
 * straight off again ends with the machine taking work.
 */
export function useSavedRunnerDrain(
  client: HerculeClient,
  runner: Runner,
): SavedField<boolean, boolean> {
  return useSavedRecordField({
    listKey: runnersQuery(client).queryKey,
    id: runner.id,
    stored: runner.lifecycle === "draining",
    applyChange: (_shown, drain: boolean) => drain,
    buildPayload: (_latest, drain) => ({ drain }),
    update: (id, { drain }) =>
      drain ? client.runner.drain({ params: { id } }) : client.runner.undrain({ params: { id } }),
  });
}
