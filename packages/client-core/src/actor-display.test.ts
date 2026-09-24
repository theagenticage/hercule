import { assert, describe, it } from "vitest";
import { describeActor } from "./actor-display";

const SESSION = "01a06d02-c111-7a0e-8b3d-9c1f7c82ebeb";

describe("describeActor", () => {
  it("shows the user as you", () => {
    assert.deepStrictEqual(describeActor("user"), { label: "you", sessionId: undefined });
  });

  it("shows system unchanged", () => {
    assert.deepStrictEqual(describeActor("system"), { label: "system", sessionId: undefined });
  });

  it("shows a session by its id tail and returns the id to link to", () => {
    assert.deepStrictEqual(describeActor(`session:${SESSION}`), {
      label: "session 7c82ebeb",
      sessionId: SESSION,
    });
  });

  it("shows an unknown actor unchanged, with no session to link to", () => {
    assert.deepStrictEqual(describeActor(`run:${SESSION}`), {
      label: `run:${SESSION}`,
      sessionId: undefined,
    });
  });
});
