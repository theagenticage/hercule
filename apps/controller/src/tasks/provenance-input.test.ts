import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { CoreProvenanceInput } from "./provenance-input";

const SIGNAL_ID = "0199e0e7-0005-7000-8000-000000000000";
const RUN_ID = "0199e0e7-0006-7000-8000-000000000000";

const decodeOutcome = (input: unknown) =>
  Effect.runSyncExit(Schema.decodeUnknownEffect(CoreProvenanceInput)(input))._tag;

describe("CoreProvenanceInput", () => {
  it("accepts an entry that names the signal, with or without a run, and refuses an empty one", () => {
    expect(decodeOutcome({ runId: RUN_ID, signalId: SIGNAL_ID })).toBe("Success");
    expect(decodeOutcome({ signalId: SIGNAL_ID })).toBe("Success");
    expect(decodeOutcome({})).toBe("Failure");
  });
});
