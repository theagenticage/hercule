import type { HerculeClient } from "@hercule/client-core";
import type { Profile } from "@hercule/contract";
import { profilesQuery } from "../../../../../app/queries";
import type { SavedField } from "../../../../../app/saved-field";
import { useSavedRecordField } from "../../../../../app/saved-record-field";

/** The payload of `profile.update`: the fields it changes. */
type ProfileUpdate = Partial<Pick<Profile, "name" | "grants">>;

/**
 * Returns one field of the profile `profileId`, whose control saves on every
 * change, by `useSavedRecordField`. `buildPayload` builds the
 * `profile.update` payload that applies the change to `latest`, the profile
 * as the cache holds it when the save starts.
 *
 * The name and the grants call it with the same list, record kind and
 * update, so they pass only what differs between fields.
 */
export function useSavedProfileField<Value, Change>(
  client: HerculeClient,
  profileId: string,
  stored: Value,
  applyChange: (value: Value, change: Change) => Value,
  buildPayload: (latest: Profile, change: Change) => ProfileUpdate,
): SavedField<Value, Change> {
  return useSavedRecordField({
    listKey: profilesQuery(client).queryKey,
    recordKind: "profile",
    id: profileId,
    stored,
    applyChange,
    buildPayload,
    update: (id, payload) => client.profile.update({ params: { id }, payload }),
  });
}
