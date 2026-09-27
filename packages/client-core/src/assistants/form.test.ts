/**
 * Tests the assistant form's four functions:
 * - `buildAssistantDraft(assistant)` fills the form from the stored assistant.
 * - `mergeAssistantEdits(assistant, edits, fields)` records an edit, and
 *   forgets one that is back at the stored value.
 * - `buildAssistantUpdate(assistant, draft)` returns only the fields the user
 *   changed, so a save leaves every other field as it is on the controller.
 * - `dropSavedEdits(edits, sent)` keeps the edits a landed save did not
 *   store, such as text typed while the save ran.
 */
import { describe, expect, it } from "vitest";
import type { Assistant } from "@hercule/contract";
import {
  buildAssistantDraft,
  buildAssistantUpdate,
  dropSavedEdits,
  mergeAssistantEdits,
} from "./form";

const AT = "2026-09-25T09:00:00.000Z";

const ADA: Assistant = {
  id: "01a06d02-a000-7000-8000-000000000001",
  name: "Ada",
  systemPrompt: "You are Ada.",
  instanceId: "01a06d02-1000-7000-8000-000000000001",
  permissionProfileId: "01a06d02-3000-7000-8000-000000000001",
  accessMode: "auto-accept-edits",
  model: null,
  disallowedTools: ["edit"],
  unenforced: [],
  heartbeat: { enabled: false, schedule: "0 7-23 * * *", prompt: "Check in.", target: "web" },
  rotation: { contextFraction: 0.7, maxContextTokens: 200000, dailyAt: "04:00" },
  reply: "turn-end",
  createdAt: AT,
  updatedAt: AT,
};

describe("buildAssistantDraft", () => {
  it("holds the assistant's stored values for the fields the form edits", () => {
    expect(buildAssistantDraft(ADA)).toEqual({
      name: "Ada",
      systemPrompt: "You are Ada.",
      instanceId: ADA.instanceId,
      permissionProfileId: ADA.permissionProfileId,
      accessMode: "auto-accept-edits",
      reply: "turn-end",
    });
  });
});

describe("mergeAssistantEdits", () => {
  it("records a new value on top of the other edits", () => {
    expect(mergeAssistantEdits(ADA, { name: "Ada L" }, { reply: "segments" })).toEqual({
      name: "Ada L",
      reply: "segments",
    });
  });

  it("replaces an earlier edit of the same field", () => {
    expect(mergeAssistantEdits(ADA, { name: "Ada L" }, { name: "Ada Lovelace" })).toEqual({
      name: "Ada Lovelace",
    });
  });

  it("drops a field whose new value equals the stored value, and keeps the others", () => {
    expect(mergeAssistantEdits(ADA, { name: "Ada L", reply: "segments" }, { name: "Ada" })).toEqual(
      { reply: "segments" },
    );
  });
});

describe("buildAssistantUpdate", () => {
  it("is empty when nothing changed", () => {
    expect(buildAssistantUpdate(ADA, buildAssistantDraft(ADA))).toEqual({});
  });

  it("holds only the changed fields", () => {
    const draft = { ...buildAssistantDraft(ADA), name: "Ada Lovelace", reply: "segments" as const };

    expect(buildAssistantUpdate(ADA, draft)).toEqual({ name: "Ada Lovelace", reply: "segments" });
  });

  it("holds every field the form edits when all of them changed", () => {
    const draft = {
      name: "Bob",
      systemPrompt: "You are Bob.",
      instanceId: "01a06d02-1000-7000-8000-000000000002",
      permissionProfileId: "01a06d02-3000-7000-8000-000000000002",
      accessMode: "full-access" as const,
      reply: "segments" as const,
    };

    expect(buildAssistantUpdate(ADA, draft)).toEqual(draft);
  });

  it("counts whitespace as a change, because values are compared exactly", () => {
    const draft = { ...buildAssistantDraft(ADA), name: "Ada " };

    expect(buildAssistantUpdate(ADA, draft)).toEqual({ name: "Ada " });
  });

  it("leaves out a field changed and then changed back", () => {
    const draft = { ...buildAssistantDraft(ADA), accessMode: "auto-accept-edits" as const };

    expect(buildAssistantUpdate(ADA, draft)).toEqual({});
  });
});

describe("dropSavedEdits", () => {
  it("drops every edit the save sent", () => {
    expect(
      dropSavedEdits({ name: "Ada L", reply: "segments" }, { name: "Ada L", reply: "segments" }),
    ).toEqual({});
  });

  it("keeps an edit typed after the save was sent", () => {
    expect(
      dropSavedEdits(
        { name: "Ada Lovelace", reply: "segments" },
        { name: "Ada L", reply: "segments" },
      ),
    ).toEqual({ name: "Ada Lovelace" });
  });

  it("keeps an edit the save did not send", () => {
    expect(dropSavedEdits({ name: "Ada L", accessMode: "auto" }, { name: "Ada L" })).toEqual({
      accessMode: "auto",
    });
  });
});
