import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { UserAvatar } from ".";

afterEach(cleanup);

/** Renders the avatar of `name` at 24 px and returns its svg. */
function renderAvatar(name: string): SVGSVGElement {
  const { container } = render(<UserAvatar name={name} size={24} />);
  return container.querySelector("svg")!;
}

describe("UserAvatar", () => {
  it("draws the first character of the name, upper-cased", () => {
    const avatar = renderAvatar("élodie");
    expect(avatar.getAttribute("class")).toBe("cr-you");
    expect(avatar.getAttribute("width")).toBe("24");
    expect(avatar.getAttribute("height")).toBe("24");
    expect(avatar.textContent).toBe("É");
  });

  it("keeps a first character made of two UTF-16 code units whole", () => {
    expect(renderAvatar("𝓡ogier").textContent).toBe("𝓡");
  });

  it("hides the avatar from assistive technology", () => {
    const avatar = renderAvatar("Rogier");
    expect(avatar.getAttribute("aria-hidden")).toBe("true");
    expect(avatar.hasAttribute("role")).toBe(false);
    expect(avatar.hasAttribute("aria-label")).toBe(false);
  });
});
