/**
 * Tests the options of the mutation that saves a Model Profile through the
 * app's query cache: the profile a save changes is the newest one in the
 * cache, a profile missing from the cache is refused with a message that says
 * what to do, a "New" row is changed by name, and the controller's answer
 * replaces the profile in the cache.
 */
import { QueryClient } from "@tanstack/query-core";
import { describe, expect, it, vi } from "vitest";
import type { ModelProfile, ModelProfileUpdateInput } from "@hercule/contract";
import {
  ANTHROPIC_IDENTITY,
  buildModelProfile,
  buildProfileEntry,
  buildProfileSection,
} from "../providers.testing";
import { moveModelProfileEntry } from "./profile-edits";
import { buildModelProfileUpdateOptions, type ModelProfilesQueryKey } from "./profile-save";

const KEY = ["model-profiles"] as unknown as ModelProfilesQueryKey;
const SONNET = buildProfileEntry(ANTHROPIC_IDENTITY, "sonnet");
const OPUS = buildProfileEntry(ANTHROPIC_IDENTITY, "opus");

/** Returns a profile at `revision` with the sections it is given. */
const readAt = (revision: number, id = "profile-main"): ModelProfile =>
  buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, [SONNET, OPUS])], { id, revision });

/** Returns the options over a cache holding `cached`, and the controller's update calls. */
const build = (cached: readonly ModelProfile[]) => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(KEY, cached);
  const update = vi.fn(
    (request: {
      readonly params: { readonly id: string };
      readonly payload: ModelProfileUpdateInput;
    }) => Promise.resolve(readAt(request.payload.expectedRevision + 1, request.params.id)),
  );
  const options = buildModelProfileUpdateOptions(
    { modelProfile: { update, read: vi.fn() } } as never,
    queryClient,
    KEY,
  );
  return { queryClient, update, options };
};

describe("buildModelProfileUpdateOptions", () => {
  it("saves the change on the newest profile in the cache, not on the one the user acted on", async () => {
    const { queryClient, update, options } = build([readAt(7)]);

    await options.mutationFn({
      profileId: "profile-main",
      buildChange: (profile) => moveModelProfileEntry(profile, OPUS, 0),
    });

    expect(update.mock.calls[0]![0].payload.expectedRevision).toBe(7);
    queryClient.setQueryData(KEY, [readAt(9)]);
    await options.mutationFn({
      profileId: "profile-main",
      buildChange: (profile) => moveModelProfileEntry(profile, OPUS, 0),
    });
    expect(update.mock.calls[1]![0].payload.expectedRevision).toBe(9);
  });

  it("refuses a profile the cache does not hold, and says to pick another", async () => {
    const { update, options } = build([readAt(7)]);

    await expect(
      options.mutationFn({
        profileId: "deleted",
        buildChange: (profile) => ({ ...profile }) as never,
      }),
    ).rejects.toThrow("This profile was deleted. Pick another profile.");
    expect(update).not.toHaveBeenCalled();
  });

  it("changes a model announced as new by its name: Add takes it in, Not now dismisses it", async () => {
    const { update, options } = build([readAt(7)]);
    const newModelEdit = { providerAccountId: ANTHROPIC_IDENTITY.id, model: "opus-5.6" };

    await options.mutationFn({
      profileId: "profile-main",
      newModelEdit: { action: "add", ...newModelEdit },
    });
    await options.mutationFn({
      profileId: "profile-main",
      newModelEdit: { action: "dismiss", ...newModelEdit },
    });

    const [added, dismissed] = update.mock.calls.map((call) => call[0].payload);
    expect(added!.accounts[0]!.entries!.map((entry) => entry.model)).toEqual([
      "sonnet",
      "opus",
      "opus-5.6",
    ]);
    expect(dismissed!.dismissedNewModels).toEqual([
      { providerAccountId: ANTHROPIC_IDENTITY.id, model: "opus-5.6" },
    ]);
  });

  it("puts the controller's answer in the cache in place of the profile", () => {
    const { queryClient, options } = build([readAt(7), readAt(3, "other")]);

    options.onSuccess(readAt(8));

    expect(queryClient.getQueryData(KEY)!.map((profile) => profile.revision)).toEqual([8, 3]);
  });
});
