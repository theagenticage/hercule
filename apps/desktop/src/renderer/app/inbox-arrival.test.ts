/** Tests the Inbox arrival the app remembers as seen, for each controller and user. */
import { describe, expect, it, vi } from "vitest";
import {
  acknowledgeInboxArrival,
  readAcknowledgedInboxArrival,
  subscribeInboxArrival,
} from "./inbox-arrival";

const HOME = "http://127.0.0.1:4937";
const WORK = "http://10.0.0.2:4937";

describe("the acknowledged Inbox arrival", () => {
  it("is 0 before anything was acknowledged, and when the stored text is not a whole number", () => {
    expect(readAcknowledgedInboxArrival(HOME, "noa")).toBe(0);
    for (const stored of ["soon", "-4", "2.5", ""]) {
      localStorage.setItem(`inbox-arrival:${HOME}:noa`, stored);
      expect(readAcknowledgedInboxArrival(HOME, "noa")).toBe(0);
    }
  });

  it("is the value acknowledged, for that controller and user only", () => {
    acknowledgeInboxArrival(HOME, "noa", 12);
    expect(readAcknowledgedInboxArrival(HOME, "noa")).toBe(12);
    expect(readAcknowledgedInboxArrival(WORK, "noa")).toBe(0);
    expect(readAcknowledgedInboxArrival(HOME, "juno")).toBe(0);
  });

  it("never goes down, so a reply shown after a newer one does not bring the dot back", () => {
    acknowledgeInboxArrival(HOME, "noa", 12);
    acknowledgeInboxArrival(HOME, "noa", 7);
    expect(readAcknowledgedInboxArrival(HOME, "noa")).toBe(12);
    acknowledgeInboxArrival(HOME, "noa", 13);
    expect(readAcknowledgedInboxArrival(HOME, "noa")).toBe(13);
  });

  it("tells a subscriber when the value rises, and not when it stays or falls", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeInboxArrival(listener);

    acknowledgeInboxArrival(HOME, "noa", 5);
    acknowledgeInboxArrival(HOME, "noa", 5);
    acknowledgeInboxArrival(HOME, "noa", 3);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    acknowledgeInboxArrival(HOME, "noa", 6);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
