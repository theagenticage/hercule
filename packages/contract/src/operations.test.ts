/**
 * Tests which operations `canCarrySecrets` reports as able to carry a
 * credential or a secret value in their input.
 */
import { describe, expect, it } from "vitest";
import { canCarrySecrets, type OperationId } from "./operations";

describe("canCarrySecrets", () => {
  it.each<OperationId>(["secret.set", "apiKey.create", "runner.update", "connection.create"])(
    "reports %s, whose grant family can carry a secret",
    (id) => {
      expect(canCarrySecrets(id)).toBe(true);
    },
  );

  it.each<OperationId>(["auth.login", "setup.complete"])(
    "reports %s, which carries a password before sign-in",
    (id) => {
      expect(canCarrySecrets(id)).toBe(true);
    },
  );

  it.each<OperationId>(["task.delete", "session.input", "profile.update"])(
    "does not report %s",
    (id) => {
      expect(canCarrySecrets(id)).toBe(false);
    },
  );
});
