import { describe, expect, it } from "vitest";
import { SESSION_STATUSES } from "@hercule/contract";
import { HARNESSES } from "../providers.testing";
import { decideAddedServerNote } from "./list-change";

describe("decideAddedServerNote", () => {
  // Every shipped harness either reads a changed tool list (Claude Code) or has
  // no gateway (Codex and pi, which the controller warns about at once), so
  // no thread shows the note until #1209 adds the capability that tells them apart.
  it("gives no note for any shipped harness in any status", () => {
    for (const harness of HARNESSES) {
      for (const status of [...SESSION_STATUSES, "draft"] as const) {
        expect(decideAddedServerNote(harness, status), `${harness.id} ${status}`).toBeNull();
      }
    }
  });

  it("gives no note while the harness list is not read", () => {
    expect(decideAddedServerNote(undefined, "busy")).toBeNull();
  });
});
