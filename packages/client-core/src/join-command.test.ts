import { describe, expect, it } from "vitest";
import { joinCommand } from "./join-command";

const origin = "https://hercule.example";
const token = "jt_a-token-nobody-else-holds";

describe("joinCommand", () => {
  it("spends the token at the address this browser reached", () => {
    expect(joinCommand({ origin, token, reserved: false })).toBe(
      `hercule runner join ${origin} --token ${token}`,
    );
  });

  it("adds the flag that enlists a personal machine, after the token", () => {
    expect(joinCommand({ origin, token, reserved: true })).toBe(
      `hercule runner join ${origin} --token ${token} --reserved`,
    );
  });
});
