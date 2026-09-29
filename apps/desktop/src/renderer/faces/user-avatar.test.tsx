import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { UserAvatar } from ".";

afterEach(cleanup);

describe("UserAvatar", () => {
  it("draws the first character of the name, upper-cased, as an image named by the name", () => {
    render(<UserAvatar name="élodie" size={24} />);
    const avatar = screen.getByRole("img", { name: "élodie" });
    expect(avatar.tagName).toBe("svg");
    expect(avatar.getAttribute("class")).toBe("cr-you");
    expect(avatar.getAttribute("width")).toBe("24");
    expect(avatar.getAttribute("height")).toBe("24");
    expect(avatar.textContent).toBe("É");
  });

  it("keeps a first character made of two UTF-16 code units whole", () => {
    render(<UserAvatar name="𝓡ogier" size={24} />);
    expect(screen.getByRole("img", { name: "𝓡ogier" }).textContent).toBe("𝓡");
  });

  it("hides a decorative avatar from assistive technology", () => {
    const { container } = render(<UserAvatar name="Rogier" size={24} decorative />);
    const avatar = container.querySelector("svg");
    expect(avatar?.getAttribute("aria-hidden")).toBe("true");
    expect(avatar?.hasAttribute("role")).toBe(false);
    expect(avatar?.hasAttribute("aria-label")).toBe(false);
    expect(screen.queryByRole("img")).toBeNull();
  });
});
