/**
 * Tests that what the Sentry plugin declares is accepted by the host's
 * schemas, so the host does not refuse the plugin when it loads.
 */
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { EntityKindDeclaration, SavedQuery } from "@hercule/plugin-host";
import { SENTRY_ENTITY_KINDS, SENTRY_SAVED_QUERIES } from "./entity-kinds";

describe("what the plugin declares", () => {
  it("is accepted by the host's schemas", () => {
    for (const kind of SENTRY_ENTITY_KINDS) {
      expect(() => Schema.decodeUnknownSync(EntityKindDeclaration)(kind)).not.toThrow();
    }
    for (const query of SENTRY_SAVED_QUERIES) {
      expect(() => Schema.decodeUnknownSync(SavedQuery)(query)).not.toThrow();
    }
  });
});
