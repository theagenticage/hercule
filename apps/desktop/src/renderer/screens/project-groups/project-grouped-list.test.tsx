/**
 * Tests that a list grouped by project, such as Discussions and Wiki, keeps
 * the row at the top of the view at the top when the Text size changes the
 * heights of its rows, and puts it back when the Text size goes back.
 */
import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ProjectGroupEntry, RepositoryRecord } from "@hercule/client-core/project-groups";
import { changeTextSize, stubElementSize } from "../../app/testing";
import { ProjectGroupedList } from "./project-grouped-list";

/** A project's heading, then 100 rows of Discussions in no project. */
const ENTRIES: readonly ProjectGroupEntry<RepositoryRecord>[] = [
  { kind: "project", key: "project:none", projectId: null, name: null },
  ...Array.from({ length: 100 }, (_, index) => ({
    kind: "item" as const,
    key: `item:none:${String(index)}`,
    item: { id: String(index), resourceId: "r", repository: "acme/repo" },
  })),
];

describe("ProjectGroupedList", () => {
  it("keeps the row at the top of the view at the top when the heights of the rows change, and when they change back", async () => {
    stubElementSize(1168, 200);
    render(
      <ProjectGroupedList
        width="table"
        label="Items"
        className="test-list"
        entries={ENTRIES}
        projects={[]}
        tableHeads={null}
        tableRow="oneLineRow"
        renderRow={(item, place) => (
          <p key={place.itemKey} data-key={place.itemKey} style={{ marginTop: place.marginTop }}>
            {item.id}
          </p>
        )}
        empty={{ title: "None", text: "None" }}
        nextPage={{
          hasNextPage: false,
          isFetching: false,
          isFetchingNextPage: false,
          isFetchNextPageError: false,
          error: null,
          fetchNextPage: () => Promise.resolve(),
        }}
        initialItemId={undefined}
      />,
    );
    const nav = screen.getByRole("navigation", { name: "Items" });
    // The band above the rows is 88px and the heading 38px with its 14px of space, so the first
    // row starts at 126px, and row 21 at 966px: the view at 1000px starts 34px into it.
    act(() => {
      nav.scrollTop = 1000;
      fireEvent.scroll(nav);
    });

    // At the largest step a one-line row is 2px taller, as the stylesheet computes it.
    await changeTextSize(4, { "--list-height-one-line-row": "42px" });
    expect(nav.scrollTop).toBeCloseTo(126 + 21 * 42 + (34 * 42) / 40);

    // The setting returns to the default, as when a save fails, before the scroll event arrives.
    await changeTextSize(2, { "--list-height-one-line-row": "40px" });
    expect(nav.scrollTop).toBeCloseTo(1000);
  });
});
