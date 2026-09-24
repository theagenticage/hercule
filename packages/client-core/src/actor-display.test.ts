import { assert, describe, it } from "vitest";
import { describeActor } from "./actor-display";

const SESSION = "01a06d02-c111-7a0e-8b3d-9c1f7c82ebeb";
const RUN = "01a06d02-c111-7a0e-8b3d-9c1f1f3a9c2e";

describe("describeActor", () => {
  it("shows the user as you, with nothing to link to", () => {
    assert.deepStrictEqual(describeActor("user"), { label: "you", link: { kind: "none" } });
  });

  it("shows system unchanged", () => {
    assert.deepStrictEqual(describeActor("system"), { label: "system", link: { kind: "none" } });
  });

  it("shows a session by its id tail and links to its thread", () => {
    assert.deepStrictEqual(describeActor(`session:${SESSION}`), {
      label: "session 7c82ebeb",
      link: { kind: "session", sessionId: SESSION },
    });
  });

  it("shows a run by its id tail and links to its page", () => {
    assert.deepStrictEqual(describeActor(`run:${RUN}`), {
      label: "run 1f3a9c2e",
      link: { kind: "run", runId: RUN },
    });
  });

  it("shows an unknown actor unchanged, with nothing to link to", () => {
    assert.deepStrictEqual(describeActor(`agent:${SESSION}`), {
      label: `agent:${SESSION}`,
      link: { kind: "none" },
    });
  });
});
