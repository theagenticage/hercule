/**
 * Tests the grid of images above a sent message's bubble: one column for a
 * single image, two for more, and a click that opens an image by index.
 * jsdom decodes no images, so the tiles show no thumbnail.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BubbleImageGrid } from "./bubble-image";
import type { TileImage } from "./image-tile";

const buildImages = (count: number): readonly TileImage[] =>
  Array.from({ length: count }, (_, index) => ({
    key: `a-${String(index)}`,
    name: `shot-${String(index)}.png`,
    thumbnail: undefined,
  }));

describe("the bubble's images", () => {
  it.each([
    [1, "1"],
    [2, "2"],
    [5, "2"],
  ])("draws %i images in %s columns", (count, columns) => {
    const { container } = render(<BubbleImageGrid images={buildImages(count)} onOpen={() => {}} />);
    const grid = container.querySelector<HTMLElement>(".bubble-images")!;
    expect(grid.style.getPropertyValue("--bubble-columns")).toBe(columns);
    expect(screen.getAllByRole("button", { name: /^Preview / })).toHaveLength(count);
  });

  it("opens the clicked image", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn<(index: number) => void>();
    render(<BubbleImageGrid images={buildImages(3)} onOpen={onOpen} />);
    await user.click(screen.getByRole("button", { name: "Preview shot-2.png" }));
    expect(onOpen).toHaveBeenCalledWith(2);
  });
});
