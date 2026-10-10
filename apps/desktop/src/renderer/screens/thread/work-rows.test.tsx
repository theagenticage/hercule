import { describe, expect, it, vi } from "vitest";
import { useState, type JSX } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WorkRow } from "@hercule/client-core";
import { WorkRowList } from "./work-rows";

// The tiles read their thumbnails from the controller, which
// tool-result-images.test.tsx covers; here a stand-in only counts them.
vi.mock("../attachments/tool-result-images", () => ({
  ToolResultImages: ({ images }: { readonly images: readonly unknown[] }) => (
    <div data-testid="tool-result-images">{images.length} images</div>
  ),
}));

/** Returns a completed command row with no output, with `fields` laid over it. */
const buildRow = (fields: Partial<WorkRow> & Pick<WorkRow, "key">): WorkRow => ({
  icon: "terminal",
  label: "Ran",
  target: "bun test",
  targetIsCode: true,
  startedAt: "2026-10-10T09:04:00Z",
  result: "completed",
  output: "",
  images: [],
  steps: [],
  canOpen: false,
  ...fields,
});

const READ_A = buildRow({ key: "step:a", icon: "eye", label: "Read", target: "/tmp/a.png" });
const READ_B = buildRow({
  key: "step:b",
  icon: "eye",
  label: "Read",
  target: "/tmp/b.png",
  output: "an image, 1280 by 800",
  canOpen: true,
});
const READS = buildRow({
  key: "row:a",
  icon: "eye",
  label: "Read 2 files",
  target: "",
  targetIsCode: false,
  steps: [READ_A, READ_B],
  canOpen: true,
});
const TEST_RUN = buildRow({
  key: "row:c",
  output: "1 pass\n1 fail",
  result: "failed",
  canOpen: true,
});
const COMMAND = buildRow({ key: "row:d", target: "git status" });
const WEB_SEARCH = buildRow({
  key: "row:e",
  icon: "globe",
  label: "Searched the web",
  target: "stripe 3ds requires_action",
  targetIsCode: false,
});

/** Renders `rows` with their open keys kept in state, as the transcript keeps them. */
function RowsWithOpenKeys({ rows }: { readonly rows: readonly WorkRow[] }): JSX.Element {
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(() => new Set());
  return (
    <WorkRowList
      rows={rows}
      openKeys={openKeys}
      onToggle={(key) => {
        setOpenKeys((keys) => {
          const next = new Set(keys);
          if (!next.delete(key)) next.add(key);
          return next;
        });
      }}
      timezone="UTC"
      today={Date.parse("2026-10-10T00:00:00Z")}
    />
  );
}

/** Returns the list item of the row that can not open whose text starts with `text`. */
const findStaticRow = (text: string): HTMLElement => {
  const found = screen
    .getAllByRole("listitem")
    .find((item) => item.textContent?.startsWith(text) === true);
  if (found === undefined) throw new Error(`No row reads "${text}".`);
  return found;
};

describe("WorkRowList", () => {
  it("draws a code target in the mono face, a target in words in the UI face, and the time", () => {
    render(<RowsWithOpenKeys rows={[COMMAND, WEB_SEARCH]} />);
    expect(within(findStaticRow("Ran git status")).getByText("git status").tagName).toBe("CODE");
    expect(
      within(findStaticRow("Searched the web")).getByText("stripe 3ds requires_action").tagName,
    ).toBe("SPAN");
    expect(findStaticRow("Ran git status").textContent).toBe("Ran git status09:04");
  });

  it("makes a row a button named by its label, target and result only when it can open", () => {
    render(<RowsWithOpenKeys rows={[READS, TEST_RUN, COMMAND]} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Read 2 files",
      "Ran, bun test, failed",
    ]);
    for (const button of buttons) expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: /git status/ })).toBeNull();
  });

  it("hides the time from screen readers", () => {
    render(<RowsWithOpenKeys rows={[COMMAND]} />);
    expect(screen.getByText("09:04").getAttribute("aria-hidden")).toBe("true");
  });

  it("shows a step's output only while the step is open", async () => {
    render(<RowsWithOpenKeys rows={[TEST_RUN]} />);
    const row = screen.getByRole("button", { name: "Ran, bun test, failed" });
    expect(screen.queryByText(/1 pass/)).toBeNull();

    await userEvent.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/1 pass/).textContent).toBe("1 pass\n1 fail");

    await userEvent.click(row);
    expect(screen.queryByText(/1 pass/)).toBeNull();
  });

  it("shows a step's images under its output, and no empty box for a step with images only", async () => {
    const image = {
      type: "image",
      attachment: {
        id: "01a06d02-7700-7000-8000-0000000000c1",
        mimeType: "image/png",
        sizeBytes: 4,
      },
    } as const;
    render(
      <RowsWithOpenKeys
        rows={[
          buildRow({ key: "row:s", output: "saved", images: [image], canOpen: true }),
          buildRow({ key: "row:t", target: "bun shot", images: [image, image], canOpen: true }),
        ]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Ran, bun test" }));
    await userEvent.click(screen.getByRole("button", { name: "Ran, bun shot" }));

    const [withText, imagesOnly] = screen.getAllByRole("listitem");
    expect(within(withText!).getByText("saved").tagName).toBe("PRE");
    expect(within(withText!).getByTestId("tool-result-images").textContent).toBe("1 images");
    expect(imagesOnly!.querySelector("pre")).toBeNull();
    expect(within(imagesOnly!).getByTestId("tool-result-images").textContent).toBe("2 images");
  });

  it("opens a group into its steps, each of which opens on its own", async () => {
    render(<RowsWithOpenKeys rows={[READS]} />);
    await userEvent.click(screen.getByRole("button", { name: "Read 2 files" }));
    expect(screen.getByRole("button", { name: "Read 2 files" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(findStaticRow("Read /tmp/a.png")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Read, /tmp/b.png" }));
    expect(screen.getByText("an image, 1280 by 800").tagName).toBe("PRE");
  });

  it("keeps a row open when a second step folds onto it, and shows its steps", async () => {
    const lone = buildRow({ key: "row:c1", output: "ok", canOpen: true });
    const { rerender } = render(<RowsWithOpenKeys rows={[lone]} />);
    await userEvent.click(screen.getByRole("button", { name: "Ran, bun test" }));
    expect(screen.getByText("ok")).toBeTruthy();

    const group = buildRow({
      key: "row:c1",
      label: "Ran 2 commands",
      target: "",
      steps: [{ ...lone, key: "step:c1" }, buildRow({ key: "step:c2", target: "bun lint" })],
      canOpen: true,
    });
    rerender(<RowsWithOpenKeys rows={[group]} />);

    expect(
      screen.getByRole("button", { name: "Ran 2 commands" }).getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.getByRole("button", { name: "Ran, bun test" })).toBeTruthy();
    expect(findStaticRow("Ran bun lint")).toBeTruthy();
  });

  it("marks a failed step with a cross named Failed, and spells out other results", () => {
    render(
      <RowsWithOpenKeys
        rows={[
          buildRow({ key: "row:f", target: "pnpm lint", result: "failed" }),
          buildRow({ key: "row:g", result: "declined" }),
          COMMAND,
        ]}
      />,
    );
    expect(
      within(findStaticRow("Ran pnpm lint")).getByRole("img", { name: "Failed" }),
    ).toBeTruthy();
    expect(within(findStaticRow("Ran bun test")).getByText("declined")).toBeTruthy();
    expect(within(findStaticRow("Ran git status")).queryByRole("img")).toBeNull();
  });
});
