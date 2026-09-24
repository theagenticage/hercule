import { describe, expect, it } from "vitest";
import { cn } from "./cn";

describe("cn", () => {
  it("keeps a font family beside a font weight of the design system", () => {
    expect(cn("font-mono", "font-emph")).toBe("font-mono font-emph");
    expect(cn("font-mono font-urgent", "font-sans")).toBe("font-urgent font-sans");
  });

  it("lets a caller's font weight replace a component's", () => {
    expect(cn("font-emph", "font-urgent")).toBe("font-urgent");
  });

  it("lets a caller's size replace a component's size but keeps its colour", () => {
    expect(cn("text-row text-ink", "text-meta")).toBe("text-ink text-meta");
  });

  it("lets a caller's radius and shadow replace a component's", () => {
    expect(cn("rounded-card shadow-card", "rounded-control shadow-lift")).toBe(
      "rounded-control shadow-lift",
    );
    expect(cn("shadow-card", "text-ink")).toBe("shadow-card text-ink");
  });
});
