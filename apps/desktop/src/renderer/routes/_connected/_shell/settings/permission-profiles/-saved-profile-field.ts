import type { HerculeClient } from "@hercule/client-core";
import type { Profile, ProfileUpdateInput } from "@hercule/contract";
import { profilesQuery } from "../../../../../app/queries";
import { useSavedRecordField, type SavedRecordField } from "../../../../../app/saved-record-field";

/**
 * Returns one field of the profile `profileId`, whose control saves on every
 * change, by `useSavedRecordField`. `buildPayload` builds the
 * `profile.update` payload that applies the change to `latest`, the profile
 * as the controller has it when the save starts.
 *
 * The name and the grants call it with the same list and update, so they pass
 * only what differs between fields. Profiles have no live topic, so the
 * cached list can be out of date, and every save reads the profile first.
 */
export function useSavedProfileField<Value, Change>(
  client: HerculeClient,
  profileId: string,
  stored: Value,
  applyChange: (value: Value, change: Change) => Value,
  buildPayload: (latest: Profile, change: Change) => ProfileUpdateInput,
): SavedRecordField<Value, Change> {
  return useSavedRecordField({
    listKey: profilesQuery(client).queryKey,
    id: profileId,
    stored,
    applyChange,
    buildPayload,
    update: (id, payload) => client.profile.update({ params: { id }, payload }),
    readLatest: (id) => client.profile.read({ params: { id } }),
  });
}
