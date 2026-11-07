/** Tests the Overview view the app remembers for each controller. */
import { describe, expect, it, vi } from "vitest";
import { readOverviewView, rememberOverviewView, subscribeOverviewView } from "./overview-view";

const HOME = "http://127.0.0.1:4937";
const WORK = "http://10.0.0.2:4937";

describe("the Overview view used last", () => {
  it("is Work before either view was used, and when the stored text is not a view", () => {
    expect(readOverviewView(HOME)).toBe("work");
    localStorage.setItem(`overview-view:${HOME}`, "list");
    expect(readOverviewView(HOME)).toBe("work");
  });

  it("is the last view remembered, for that controller only", () => {
    rememberOverviewView(HOME, "office");
    expect(readOverviewView(HOME)).toBe("office");
    expect(readOverviewView(WORK)).toBe("work");

    rememberOverviewView(HOME, "work");
    expect(readOverviewView(HOME)).toBe("work");
  });

  it("tells a subscriber when the view changes, and not when it is remembered again", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeOverviewView(listener);

    rememberOverviewView(HOME, "office");
    rememberOverviewView(HOME, "office");
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    rememberOverviewView(HOME, "work");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
