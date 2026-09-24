import { describe, expect, it } from "vitest";
import { joinCommand } from "./join-command";

const origin = "https://hercule.example";
const token = "jt_a-token-nobody-else-holds";

describe("joinCommand", () => {
  it("uses the token with the address this browser is using", () => {
    expect(joinCommand({ origin, token, reserved: false })).toBe(
      `hercule runner join ${origin} --token ${token}`,
    );
  });

  it("adds --reserved after the token for a reserved runner", () => {
    expect(joinCommand({ origin, token, reserved: true })).toBe(
      `hercule runner join ${origin} --token ${token} --reserved`,
    );
  });
});
