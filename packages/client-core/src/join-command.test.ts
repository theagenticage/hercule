import { describe, expect, it } from "vitest";
import { joinCommand } from "./join-command";

const origin = "https://hydra.example";
const token = "jt_a-token-nobody-else-holds";

describe("joinCommand", () => {
  it("spends the token at the address this browser reached", () => {
    expect(joinCommand({ origin, token, reserved: false })).toBe(
      `hydra runner join ${origin} --token ${token}`,
    );
  });

  it("adds the flag that enlists a personal machine, after the token", () => {
    expect(joinCommand({ origin, token, reserved: true })).toBe(
      `hydra runner join ${origin} --token ${token} --reserved`,
    );
  });
});
