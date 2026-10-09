/**
 * Tests the Settings header: the section's own title by default, and the
 * parent crumb and record title a section draws with `SettingsHeaderTitle`.
 */
import { useState, type JSX } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { SettingsFrame, SettingsHeaderTitle } from "./settings-frame";

/** A section that names a record, whose name the test edits and whose header title it can close. */
function Record({ named }: { readonly named: boolean }): JSX.Element {
  const [name, setName] = useState("Reviewer");
  const [open, setOpen] = useState(named);
  return (
    <>
      <button onClick={() => setName("Auditor")}>Rename</button>
      <button onClick={() => setOpen(false)}>Close</button>
      {open && (
        <SettingsHeaderTitle
          parent={{ title: "Assistants", to: "/settings/assistants" }}
          title={name}
        />
      )}
    </>
  );
}

const renderFrame = async (named: boolean) => {
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <SettingsFrame title="Appearance" list={null}>
          <Record named={named} />
        </SettingsFrame>
      ),
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
  await screen.findByRole("heading", { level: 1 });
};

const readHeader = () => document.querySelector("header")?.textContent;

describe("the Settings header", () => {
  it("shows the section's title under the crumb when no section names a record", async () => {
    await renderFrame(false);
    expect(readHeader()).toBe("Settings /Appearance");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows the parent as a link in the crumb, and the record's current name as the title", async () => {
    await renderFrame(true);
    expect(readHeader()).toBe("Settings / Assistants /Reviewer");
    expect(screen.getByRole("link", { name: "Assistants" }).getAttribute("href")).toBe(
      "/settings/assistants",
    );

    await userEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Auditor");
  });

  it("returns to the section's title when the record closes", async () => {
    await renderFrame(true);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(readHeader()).toBe("Settings /Appearance");
    expect(screen.queryByRole("link")).toBeNull();
  });
});
