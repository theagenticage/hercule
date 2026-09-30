import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { POSES, type Pose } from "@hercule/client-core";
import { buildLook, Face, type Look } from ".";

afterEach(cleanup);

/** A look that wears nothing, so only the pose changes the face. */
const PLAIN: Look = { hue: "iris", shape: "egg", accessories: [] };

/** Renders a face with the given props, `PLAIN` idle at 34 px otherwise, and returns its root element. */
function renderFace({
  look = PLAIN,
  pose = "idle",
  size = 34,
  animated = false,
}: {
  readonly look?: Look;
  readonly pose?: Pose;
  readonly size?: number;
  readonly animated?: boolean;
}): SVGSVGElement {
  const { container } = render(<Face look={look} pose={pose} size={size} animated={animated} />);
  return container.querySelector("svg")!;
}

describe("Face", () => {
  const BODY_PATHS = [
    [
      "egg",
      "M24 9.6C32.64 9.6 38.4 19.63 38.4 30.5C38.4 37.88 34.08 42.4 24 42.4C13.92 42.4 9.6 37.88 9.6 30.5C9.6 19.63 15.36 9.6 24 9.6Z",
    ],
    [
      "tall",
      "M24 8.4C31.68 8.4 36.8 19.25 36.8 31C36.8 38.07 32.96 42.4 24 42.4C15.04 42.4 11.2 38.07 11.2 31C11.2 19.25 16.32 8.4 24 8.4Z",
    ],
    [
      "round",
      "M24 11C33.24 11 39.4 19.88 39.4 29.5C39.4 37.5 34.78 42.4 24 42.4C13.22 42.4 8.6 37.5 8.6 29.5C8.6 19.88 14.76 11 24 11Z",
    ],
    // The left edge is 7.800000000000001, not 7.8. crew.js leaves the edges'
    // x unrounded, and 24 - 16.2 is 7.800000000000001 in floating point. The
    // port computes it the same way on purpose, so the path equals the book's
    // string. It is not a bug: do not round it.
    [
      "wide",
      "M24 12.6C33.72 12.6 40.2 21.43 40.2 31C40.2 38.07 35.34 42.4 24 42.4C12.66 42.4 7.800000000000001 38.07 7.800000000000001 31C7.800000000000001 21.43 14.28 12.6 24 12.6Z",
    ],
  ] as const;

  it.each(BODY_PATHS)("draws the %s body as the Bureau book does", (shape, path) => {
    const face = renderFace({ look: { ...PLAIN, shape } });
    const [shade, body] = face.querySelectorAll("path");
    expect(shade?.getAttribute("d")).toBe(path);
    expect(shade?.getAttribute("fill")).toBe("var(--who-shade)");
    expect(body?.getAttribute("d")).toBe(path);
    expect(body?.getAttribute("fill")).toBe("var(--who)");
    expect(body?.getAttribute("transform")).toBe("translate(0 -2)");
  });

  it.each(POSES)("draws the %s pose as an svg in the look's hue", (pose) => {
    const face = renderFace({
      look: buildLook("0199a3c2-7b41-7e2a-9c3d-5f1e2a8b4c60"),
      pose,
      size: 22,
    });
    expect(face.getAttribute("class")).toBe(`cr cr--${pose}`);
    expect(face.getAttribute("viewBox")).toBe("3 1 45 45");
    expect(face.getAttribute("width")).toBe("22");
    expect(face.getAttribute("height")).toBe("22");
    expect(face.style.getPropertyValue("--hue")).toBe("var(--hue-lime)");
  });

  it.each([false, true])("hides the face from assistive technology, animated %s", (animated) => {
    const { container } = render(
      <Face look={PLAIN} pose="working" size={24} animated={animated} />,
    );
    const face = container.firstElementChild!;
    expect(face.getAttribute("aria-hidden")).toBe("true");
    expect(face.hasAttribute("role")).toBe(false);
    expect(face.hasAttribute("aria-label")).toBe(false);
  });

  // Below 30 px the eyes are 1.2 times larger: the eyes' x radius is 2.4
  // instead of 2, and the glint's radius is 0.84 instead of 0.7.
  it.each([
    [29, "2.4", "0.84"],
    [30, "2", "0.7"],
  ])(
    "at %i px draws the idle eyes with an x radius of %s, and a glint of %s",
    (size, rx, glint) => {
      const face = renderFace({ pose: "idle", size });
      const eyes = face.querySelectorAll('ellipse[fill="var(--face-ink)"]');
      const glints = face.querySelectorAll('circle[fill="#fff"]');
      expect(eyes).toHaveLength(2);
      expect(glints).toHaveLength(2);
      for (const eye of eyes) expect(eye.getAttribute("rx")).toBe(rx);
      for (const circle of glints) expect(circle.getAttribute("r")).toBe(glint);
    },
  );

  describe("under a tache", () => {
    const TACHE: Look = { ...PLAIN, accessories: ["tache"] };

    it("moves the mouth from y 32.6 down to y 34.4", () => {
      // The failed mouth is a wave 0.6 below the mouth's y.
      const failedPlain = renderFace({ pose: "failed" });
      const failedTache = renderFace({ look: TACHE, pose: "failed" });
      expect(failedPlain.querySelector('path[d^="M21.4 "]')?.getAttribute("d")).toBe(
        "M21.4 33.2q1.3-1.3 2.6 0t2.6 0",
      );
      expect(failedTache.querySelector('path[d^="M21.4 "]')?.getAttribute("d")).toBe(
        "M21.4 35q1.3-1.3 2.6 0t2.6 0",
      );
      // The waiting mouth is an "o" 0.2 below the mouth's y.
      const waitingTache = renderFace({ look: TACHE, pose: "waiting" });
      expect(waitingTache.querySelector('ellipse[cx="24"]')?.getAttribute("cy")).toBe("34.6");
    });

    it("hides the idle smile", () => {
      expect(renderFace({ pose: "idle" }).querySelector('path[d^="M21.6 "]')).not.toBeNull();
      expect(
        renderFace({ look: TACHE, pose: "idle" }).querySelector('path[d^="M21.6 "]'),
      ).toBeNull();
    });
  });

  it.each(POSES)("draws the %s pose without the book's animation classes", (pose) => {
    const face = renderFace({ pose });
    expect(face.querySelector(".cr-eyes, .cr-wave, .cr-z")).toBeNull();
  });

  it.each(POSES.filter((pose) => pose !== "working"))(
    "with animated, draws the %s face exactly as without",
    (pose) => {
      expect(renderFace({ pose, animated: true }).outerHTML).toBe(renderFace({ pose }).outerHTML);
    },
  );

  it("marks the still working face's two paws with the book's cr-tap classes", () => {
    const paws = renderFace({ pose: "working" }).querySelectorAll(".cr-tap");
    expect([...paws].map((paw) => paw.getAttribute("class"))).toEqual([
      "cr-tap",
      "cr-tap cr-tap--2",
    ]);
  });

  it("with animated, draws the working face's paws each in its own svg, in a span face.css moves", () => {
    const still = renderFace({ pose: "working" });
    const { container } = render(<Face look={PLAIN} pose="working" size={34} animated />);
    const face = container.firstElementChild as HTMLElement;
    expect(face.tagName).toBe("SPAN");
    expect(face.getAttribute("class")).toBe("cr cr--working cr--animated");
    expect(face.style.getPropertyValue("--hue")).toBe("var(--hue-iris)");
    const [drawing, leftPaw, rightPaw, ...rest] = face.children;
    expect(rest).toEqual([]);

    // The first svg is the still face without its paws' group, which comes last.
    still.lastElementChild!.remove();
    expect(drawing?.outerHTML).toBe(
      `<svg viewBox="3 1 45 45" width="34" height="34">${still.innerHTML}</svg>`,
    );
    const paint =
      'fill="var(--who-shade)" stroke="var(--face-ink)" stroke-opacity=".25" stroke-width=".6"';
    expect(leftPaw?.outerHTML).toBe(
      `<span class="cr-tap"><svg viewBox="3 1 45 45" width="34" height="34"><g ${paint}><ellipse cx="18" cy="40.4" rx="2.8" ry="1.9"></ellipse></g></svg></span>`,
    );
    expect(rightPaw?.outerHTML).toBe(
      `<span class="cr-tap cr-tap--2"><svg viewBox="3 1 45 45" width="34" height="34"><g ${paint}><ellipse cx="30" cy="40.4" rx="2.8" ry="1.9"></ellipse></g></svg></span>`,
    );
  });

  // The number of elements in the Bureau book's `face` in crew.js, root
  // included, for the seeds of look.test.ts, in the order of `POSES`. The app
  // draws fewer, because it leaves out two groups that exist only to animate:
  // - the eyes' blink group, in every pose;
  // - the waving arm's group, in the waiting pose.
  const BOOK_ELEMENT_COUNTS = [
    ["", "mint, wide, tache", [24, 19, 13, 14, 20, 14, 14, 14]],
    ["a", "peach, egg, watch", [27, 21, 16, 17, 22, 17, 16, 17]],
    [
      "0199a3c2-7b41-7e2a-9c3d-5f1e2a8b4c60",
      "lime, wide, tache + bowtie",
      [26, 21, 15, 16, 22, 16, 16, 16],
    ],
    [
      "0199a3c2-7b41-7e2a-9c3d-5f1e2a8b4c61",
      "lime, tall, glasses",
      [27, 21, 16, 17, 22, 17, 16, 17],
    ],
    ["0199a3c4-0d12-7a55-8b10-3e9f7c21d0aa", "iris, egg, bowtie", [25, 19, 14, 15, 20, 15, 14, 15]],
    [
      "Fix 3-D Secure checkout for EU cards",
      "teal, tall, bowtie",
      [25, 19, 14, 15, 20, 15, 14, 15],
    ],
  ] as const;

  it.each(BOOK_ELEMENT_COUNTS)(
    "draws the face of seed %j (%s) with the book's elements, minus its animation groups",
    (seed, _look, bookCounts) => {
      const look = buildLook(seed);
      const counts = POSES.map(
        (pose) => renderFace({ look, pose }).querySelectorAll("*").length + 1,
      );
      const expected = POSES.map(
        (pose, index) => bookCounts[index]! - (pose === "waiting" ? 2 : 1),
      );
      expect(counts).toEqual(expected);
    },
  );
});
