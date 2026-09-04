import { describe, expect, it } from "vitest";
// The controller enforces grants; the contract puts them on the wire. Both need
// the same list, and this is the only place the two copies meet. A test-only
// import: no runtime edge from the contract to the controller, and the
// controller already depends on this package, so nothing here is a cycle.
import { ALL_GRANTS as CONTROLLER_GRANTS } from "../../../apps/controller/src/permissions/profiles";
import { ALL_GRANTS } from "./grants";

describe("the grant vocabulary", () => {
  it("is the same list the controller enforces", () => {
    expect(ALL_GRANTS).toEqual(CONTROLLER_GRANTS);
  });
});
