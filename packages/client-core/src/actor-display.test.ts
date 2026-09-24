import { assert, describe, it } from "vitest";
import { describeActor } from "./actor-display";

const SESSION = "01a06d02-c111-7a0e-8b3d-9c1f7c82ebeb";
const RUN = "01a06d02-c111-7a0e-8b3d-9c1f1f3a9c2e";

describe("describeActor", () => {
  it("shows the user as you", () => {
    assert.deepStrictEqual(describeActor("user"), {
      label: "you",
      sessionId: undefined,
      runId: undefined,
    });
  });

  it("shows system unchanged", () => {
    assert.deepStrictEqual(describeActor("system"), {
      label: "system",
      sessionId: undefined,
      runId: undefined,
    });
  });

  it("shows a session by its id tail and returns the id to link to", () => {
    assert.deepStrictEqual(describeActor(`session:${SESSION}`), {
      label: "session 7c82ebeb",
      sessionId: SESSION,
      runId: undefined,
    });
  });

  it("shows a run by its id tail and returns the id to link to", () => {
    assert.deepStrictEqual(describeActor(`run:${RUN}`), {
      label: "run 1f3a9c2e",
      sessionId: undefined,
      runId: RUN,
    });
  });

  it("shows an unknown actor unchanged, with nothing to link to", () => {
    assert.deepStrictEqual(describeActor(`agent:${SESSION}`), {
      label: `agent:${SESSION}`,
      sessionId: undefined,
      runId: undefined,
    });
  });
});
