import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button } from "./button";
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from "./dialog";
import { Input } from "./input";
import { Label } from "./label";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";
import { SegmentedControl, SegmentedControlItem } from "./segmented-control";

describe("Button", () => {
  it("never submits a form unless asked to", () => {
    render(<Button>Allow</Button>);
    expect(screen.getByRole("button", { name: "Allow" })).toHaveProperty("type", "button");
  });

  it("reports the press", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Allow</Button>);
    await userEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("is inert while disabled", async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Allow
      </Button>,
    );
    await userEvent.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("is quiet unless the primary answer asks otherwise", () => {
    const { rerender } = render(<Button>Deny</Button>);
    expect(screen.getByRole("button").dataset.variant).toBe("quiet");
    rerender(<Button variant="primary">Allow</Button>);
    expect(screen.getByRole("button").dataset.variant).toBe("primary");
  });

  it("lets a caller's class win over its own", () => {
    render(<Button className="px-6">Allow</Button>);
    const classes = screen.getByRole("button").className;
    expect(classes).toContain("px-6");
    expect(classes).not.toContain("px-2 ");
  });
});

describe("Input and Label", () => {
  it("hands focus to the field its label names", async () => {
    render(
      <>
        <Label htmlFor="username">Username</Label>
        <Input id="username" />
      </>,
    );
    await userEvent.click(screen.getByText("Username"));
    expect(screen.getByLabelText("Username")).toBe(document.activeElement);
  });

  it("carries what the user types", async () => {
    render(<Input aria-label="Username" />);
    const field = screen.getByLabelText("Username");
    await userEvent.type(field, "rogier");
    expect(field).toHaveProperty("value", "rogier");
  });
});

describe("Popover", () => {
  function Example() {
    return (
      <Popover>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Inside</PopoverContent>
      </Popover>
    );
  }

  it("stays closed until its trigger is pressed", async () => {
    render(<Example />);
    expect(screen.queryByText("Inside")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByText("Inside")).toBeTruthy();
  });

  it("closes on Escape", async () => {
    render(<Example />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByText("Inside")).toBeNull();
  });
});

describe("Dialog", () => {
  function Example() {
    return (
      <Dialog>
        <DialogTrigger>Open</DialogTrigger>
        <DialogContent>
          <DialogTitle>Delete legacy channel tables?</DialogTitle>
          <DialogClose>Cancel</DialogClose>
        </DialogContent>
      </Dialog>
    );
  }

  it("opens with its title as its accessible name", async () => {
    render(<Example />);
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByRole("dialog").getAttribute("aria-labelledby")).toBeTruthy();
    expect(screen.getByRole("dialog").textContent).toContain("Delete legacy channel tables?");
  });

  it("closes on Escape and on its own close control", async () => {
    render(<Example />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Select", () => {
  function Example({ onValueChange = () => {} }: { onValueChange?: (value: string) => void }) {
    return (
      <Select onValueChange={onValueChange}>
        <SelectTrigger aria-label="Access mode">
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="approval-required">Approval required</SelectItem>
          <SelectItem value="unrestricted">Unrestricted</SelectItem>
        </SelectContent>
      </Select>
    );
  }

  it("shows its placeholder until a value is picked", () => {
    render(<Example />);
    expect(screen.getByRole("combobox", { name: "Access mode" }).textContent).toContain("Pick one");
  });

  it("reports the value the user picks", async () => {
    const onValueChange = vi.fn();
    render(<Example onValueChange={onValueChange} />);
    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(screen.getByRole("option", { name: "Unrestricted" }));
    expect(onValueChange).toHaveBeenCalledWith("unrestricted");
  });
});

describe("SegmentedControl", () => {
  function Example() {
    const [face, setFace] = useState("threads");
    return (
      <SegmentedControl value={face} onValueChange={setFace} aria-label="Sidebar face">
        <SegmentedControlItem value="threads">Threads</SegmentedControlItem>
        <SegmentedControlItem value="hydra">Hydra</SegmentedControlItem>
      </SegmentedControl>
    );
  }

  it("marks exactly one face as on", async () => {
    render(<Example />);
    expect(screen.getByRole("radio", { name: "Threads" }).dataset.state).toBe("on");
    await userEvent.click(screen.getByRole("radio", { name: "Hydra" }));
    expect(screen.getByRole("radio", { name: "Hydra" }).dataset.state).toBe("on");
    expect(screen.getByRole("radio", { name: "Threads" }).dataset.state).toBe("off");
  });

  it("has no off state: pressing the face already on leaves it on", async () => {
    render(<Example />);
    await userEvent.click(screen.getByRole("radio", { name: "Threads" }));
    expect(screen.getByRole("radio", { name: "Threads" }).dataset.state).toBe("on");
  });

  it("moves between faces with the arrow keys", async () => {
    render(<Example />);
    await userEvent.tab();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Hydra" })).toBe(document.activeElement);
  });
});
