/**
 * Tests that a change to a Model Profile is sent once with the revision that
 * was read, and again from a fresh read when the controller reports a conflict.
 */
import { describe, expect, it, vi } from "vitest";
import type { ModelProfile, ModelProfileUpdateInput } from "@hercule/contract";
import {
  ANTHROPIC_IDENTITY,
  buildModelProfile,
  buildProfileEntry,
  buildProfileSection,
} from "../providers.testing";
import { ApiError } from "../errors";
import { makeDefaultModelProfileEntry, moveModelProfileEntry } from "./profile-edits";
import { updateModelProfile } from "./update-profile";

const SONNET = buildProfileEntry(ANTHROPIC_IDENTITY, "sonnet");
const OPUS = buildProfileEntry(ANTHROPIC_IDENTITY, "opus");
const HAIKU = buildProfileEntry(ANTHROPIC_IDENTITY, "haiku");

/** Returns a profile at `revision` holding Anthropic's models in `entries` order. */
const readAt = (revision: number, entries = [SONNET, OPUS, HAIKU]): ModelProfile =>
  buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, entries)], { revision });

/** Returns a controller that answers `answers` to the updates, in order, and `fresh` to a read. */
const buildController = (answers: ReadonlyArray<ModelProfile | ApiError>, fresh?: ModelProfile) => {
  let sent = 0;
  const update = vi.fn<
    (request: { readonly payload: ModelProfileUpdateInput }) => Promise<ModelProfile>
  >(() => {
    const answer = answers[sent++];
    if (answer === undefined)
      return Promise.reject(new Error("The test has no answer for this update."));
    if (answer instanceof ApiError) return Promise.reject(answer);
    return Promise.resolve(answer);
  });
  const read = vi.fn(() => Promise.resolve(fresh ?? readAt(1)));
  return { client: { modelProfile: { update, read } } as never, update, read };
};

const conflict = new ApiError("conflict", "The profile changed since you read it.");

describe("updateModelProfile", () => {
  it("sends the change once, with the revision that was read, and reads nothing", async () => {
    const saved = readAt(8);
    const { client, update, read } = buildController([saved]);

    const result = await updateModelProfile(client, readAt(7), (profile) =>
      moveModelProfileEntry(profile, OPUS, 0),
    );

    expect(result).toBe(saved);
    expect(update).toHaveBeenCalledOnce();
    expect(update.mock.calls[0]![0].payload.expectedRevision).toBe(7);
    expect(read).not.toHaveBeenCalled();
  });

  it("reads the profile again on a conflict and applies the same change to it", async () => {
    // Someone else moved Haiku to the top, so Opus is now second.
    const fresh = readAt(8, [HAIKU, SONNET, OPUS]);
    const saved = readAt(9, [OPUS, HAIKU, SONNET]);
    const { client, update, read } = buildController([conflict, saved], fresh);

    const result = await updateModelProfile(client, readAt(7), (profile) =>
      moveModelProfileEntry(profile, OPUS, 0),
    );

    expect(result).toBe(saved);
    expect(read).toHaveBeenCalledOnce();
    const retry = update.mock.calls[1]![0].payload;
    expect(retry.expectedRevision).toBe(8);
    expect(retry.accounts[0]!.entries!.map(({ model }) => model)).toEqual([
      "opus",
      "haiku",
      "sonnet",
    ]);
  });

  it("fails with the controller's error when it refuses for another reason", async () => {
    const refusal = new ApiError("validation", "The default is not among the entries.");
    const { client, update, read } = buildController([refusal]);

    await expect(
      updateModelProfile(client, readAt(7), (profile) =>
        makeDefaultModelProfileEntry(profile, SONNET),
      ),
    ).rejects.toBe(refusal);
    expect(update).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
  });

  it("gives up with the conflict when the profile changes under every attempt", async () => {
    const { client, update } = buildController([conflict, conflict, conflict]);

    await expect(
      updateModelProfile(client, readAt(7), (profile) => moveModelProfileEntry(profile, OPUS, 0)),
    ).rejects.toBe(conflict);
    expect(update).toHaveBeenCalledTimes(3);
  });
});
