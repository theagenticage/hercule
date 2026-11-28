/**
 * Saves one change to a Model Profile. `modelProfile.update` refuses a write
 * with `conflict` when the profile changed since the revision the write
 * carries, so a change is built from the profile as it was read, and built
 * again from a fresh read when the controller says another write got there
 * first (spec 17, Settings > Providers, Saving).
 */
import type { ModelProfile, ModelProfileUpdateInput } from "@hercule/contract";
import type { HerculeClient } from "../client";
import { isConflict } from "../errors";

/** How many times a change is sent before the conflict is given up on. */
const MAX_ATTEMPTS = 3;

/**
 * Sends the change `buildChange` makes to `profile` and returns the profile
 * as the controller now holds it.
 *
 * `profile` is the profile as the caller last read it. It is sent first, with
 * no read of its own, so one change costs one request. When the controller
 * answers `conflict`, the profile is read again and `buildChange` is called
 * with the fresh profile, so the user's one change is applied to what is
 * there now and not to what they saw. `buildChange` must therefore describe
 * the change by what it is (this entry moves to the top), not by a copy of the
 * old profile.
 *
 * Fails with the controller's error for any other refusal, without trying
 * again: a name already taken or a model the entry's harness does not list is
 * a `validation` error, and its message says what to change. Fails with the
 * last `conflict` when the profile changed on every attempt.
 */
export const updateModelProfile = async (
  client: { readonly modelProfile: Pick<HerculeClient["modelProfile"], "read" | "update"> },
  profile: ModelProfile,
  buildChange: (profile: ModelProfile) => ModelProfileUpdateInput,
): Promise<ModelProfile> => {
  let current = profile;
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.modelProfile.update({
        params: { id: current.id },
        payload: buildChange(current),
      });
    } catch (error) {
      if (!isConflict(error) || attempt === MAX_ATTEMPTS) throw error;
      current = await client.modelProfile.read({ params: { id: current.id } });
    }
  }
};
