import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button } from "./button";
import { Checkbox } from "./checkbox";
import { Input } from "./input";
import { Label } from "./label";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { Select } from "./select";
import { SegmentedControl, SegmentedControlItem } from "./segmented-control";
import { StringList } from "./string-list";

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

  it("keeps its own size when it carries a colour of its own", () => {
    // The type scale is named, not sized, so the merge has to be told the
    // difference: a button whose size was dropped inherits the ambient one.
    render(<Button>Allow</Button>);
    expect(screen.getByRole("button").className).toContain("text-row");
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

describe("Select", () => {
  function Example({ onChange = () => {} }: { onChange?: (value: string) => void }) {
    return (
      <Select
        aria-label="Timezone"
        defaultValue="Europe/Amsterdam"
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        <option value="Europe/Amsterdam">Europe/Amsterdam</option>
        <option value="UTC">UTC</option>
      </Select>
    );
  }

  it("shows the value it starts on", () => {
    render(<Example />);
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Timezone" }).value).toBe(
      "Europe/Amsterdam",
    );
  });

  it("reports the value the user picks", async () => {
    const onChange = vi.fn();
    render(<Example onChange={onChange} />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Timezone" }), "UTC");
    expect(onChange).toHaveBeenCalledWith("UTC");
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

describe("StringList", () => {
  function Example({ initial = ["alpha"] }: { readonly initial?: readonly string[] }) {
    const [values, setValues] = useState<readonly string[]>(initial);
    return <StringList label="Tag" values={values} onChange={setValues} />;
  }

  it("names each entry by its place, so a screen reader can tell them apart", () => {
    render(<Example initial={["alpha", "beta"]} />);
    expect(screen.getByLabelText<HTMLInputElement>("Tag entry 1").value).toBe("alpha");
    expect(screen.getByLabelText<HTMLInputElement>("Tag entry 2").value).toBe("beta");
  });

  it("reports an edited entry with the rest of the list beside it", async () => {
    render(<Example initial={["alpha", "beta"]} />);
    await userEvent.type(screen.getByLabelText("Tag entry 1"), "!");
    expect(screen.getByLabelText<HTMLInputElement>("Tag entry 1").value).toBe("alpha!");
    expect(screen.getByLabelText<HTMLInputElement>("Tag entry 2").value).toBe("beta");
  });

  it("grows by an empty entry and shrinks by the one removed", async () => {
    render(<Example initial={["alpha", "beta"]} />);
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByLabelText<HTMLInputElement>("Tag entry 3").value).toBe("");

    await userEvent.click(screen.getByRole("button", { name: "Remove Tag entry 1" }));
    expect(screen.getByLabelText<HTMLInputElement>("Tag entry 1").value).toBe("beta");
    expect(screen.queryByLabelText("Tag entry 3")).toBeNull();
  });

  it("shows only the way to add when there is nothing in the list", () => {
    render(<Example initial={[]} />);
    expect(screen.queryByLabelText("Tag entry 1")).toBeNull();
    expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
  });
});

describe("Checkbox", () => {
  function Example() {
    const [on, setOn] = useState(false);
    return (
      <Checkbox
        label="Verbose"
        checked={on}
        onChange={(event) => {
          setOn(event.target.checked);
        }}
      />
    );
  }

  it("is reached by the name beside it", async () => {
    render(<Example />);
    expect(screen.getByLabelText<HTMLInputElement>("Verbose").checked).toBe(false);
    await userEvent.click(screen.getByText("Verbose"));
    expect(screen.getByLabelText<HTMLInputElement>("Verbose").checked).toBe(true);
  });
});
