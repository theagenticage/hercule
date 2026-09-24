import { assert, describe, it } from "vitest";
import { describeActor } from "./actor-display";

const SESSION = "01a06d02-c111-7a0e-8b3d-9c1f7c82ebeb";

describe("describeActor", () => {
  it("names the user as the person reading the screen", () => {
    assert.deepStrictEqual(describeActor("user"), { label: "you", sessionId: undefined });
  });

  it("leaves system as it arrived", () => {
    assert.deepStrictEqual(describeActor("system"), { label: "system", sessionId: undefined });
  });

  it("names a session by its tail and hands back the id to link to", () => {
    assert.deepStrictEqual(describeActor(`session:${SESSION}`), {
      label: "session 7c82ebeb",
      sessionId: SESSION,
    });
  });

  it("leaves a stamp it does not know as it arrived, with nothing to link to", () => {
    assert.deepStrictEqual(describeActor(`run:${SESSION}`), {
      label: `run:${SESSION}`,
      sessionId: undefined,
    });
  });
});
