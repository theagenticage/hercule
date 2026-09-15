import { assert, describe, it } from "vitest";
import { actorReading } from "./actor-display";

const SESSION = "01a06d02-c111-7a0e-8b3d-9c1f7c82ebeb";

describe("actorReading", () => {
  it("names the user as the person reading the screen", () => {
    assert.deepStrictEqual(actorReading("user"), { label: "you", sessionId: undefined });
  });

  it("leaves system as it arrived", () => {
    assert.deepStrictEqual(actorReading("system"), { label: "system", sessionId: undefined });
  });

  it("names a session by its tail and hands back the id to link to", () => {
    assert.deepStrictEqual(actorReading(`session:${SESSION}`), {
      label: "session 7c82ebeb",
      sessionId: SESSION,
    });
  });

  it("names a run by its tail, with nothing to link to", () => {
    assert.deepStrictEqual(actorReading(`run:${SESSION}`), {
      label: "run 7c82ebeb",
      sessionId: undefined,
    });
  });

  it("shows a plugin's slug whole, because an author chose it", () => {
    assert.deepStrictEqual(actorReading("plugin:github"), {
      label: "plugin github",
      sessionId: undefined,
    });
  });
});
