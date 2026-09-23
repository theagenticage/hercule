import { useState, type FormEvent } from "react";
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
import { Switch } from "./switch";

describe("Button", () => {
  it("never submits a form unless asked to", () => {
    render(<Button>Allow</Button>);
    expect(screen.getByRole("button", { name: "Allow" })).toHaveProperty("type", "button");
  });

  it("calls onClick when pressed", async () => {
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

  // A Save button keeps focus while its save is in flight, so a keyboard user
  // does not lose their place.
  it("ignores clicks, does not submit and keeps focus while aria-disabled", async () => {
    const onClick = vi.fn();
    const onSubmit = vi.fn((event: FormEvent) => {
      event.preventDefault();
    });
    render(
      <form onSubmit={onSubmit}>
        <Button type="submit" aria-disabled onClick={onClick}>
          Save
        </Button>
      </form>,
    );
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    await userEvent.click(screen.getByRole("button"));

    expect(onClick).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button"));
  });

  it("uses the quiet variant unless another variant is given", () => {
    const { rerender } = render(<Button>Deny</Button>);
    expect(screen.getByRole("button").dataset.variant).toBe("quiet");
    rerender(<Button variant="primary">Allow</Button>);
    expect(screen.getByRole("button").dataset.variant).toBe("primary");
  });

  it("keeps its font size class next to its colour classes", () => {
    // The type scale uses names, not sizes, so tailwind-merge must be told they
    // are sizes. A button whose size class was dropped would inherit the
    // surrounding font size.
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
  it("focuses the field when its label is clicked", async () => {
    render(
      <>
        <Label htmlFor="username">Username</Label>
        <Input id="username" />
      </>,
    );
    await userEvent.click(screen.getByText("Username"));
    expect(screen.getByLabelText("Username")).toBe(document.activeElement);
  });

  it("holds what the user types", async () => {
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

  it("calls onChange with the value the user picks", async () => {
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
        <SegmentedControlItem value="hercule">Hercule</SegmentedControlItem>
      </SegmentedControl>
    );
  }

  it("shows exactly one option as selected", async () => {
    render(<Example />);
    expect(screen.getByRole("radio", { name: "Threads" }).dataset.state).toBe("on");
    await userEvent.click(screen.getByRole("radio", { name: "Hercule" }));
    expect(screen.getByRole("radio", { name: "Hercule" }).dataset.state).toBe("on");
    expect(screen.getByRole("radio", { name: "Threads" }).dataset.state).toBe("off");
  });

  it("has no off state: pressing the selected option keeps it selected", async () => {
    render(<Example />);
    await userEvent.click(screen.getByRole("radio", { name: "Threads" }));
    expect(screen.getByRole("radio", { name: "Threads" }).dataset.state).toBe("on");
  });

  it("moves between options with the arrow keys", async () => {
    render(<Example />);
    await userEvent.tab();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Hercule" })).toBe(document.activeElement);
  });
});

describe("StringList", () => {
  function Example({ initial = ["alpha"] }: { readonly initial?: readonly string[] }) {
    const [values, setValues] = useState<readonly string[]>(initial);
    return <StringList label="Tag" values={values} onChange={setValues} />;
  }

  it("names each entry by its position, so a screen reader can tell them apart", () => {
    render(<Example initial={["alpha", "beta"]} />);
    expect(screen.getByLabelText<HTMLInputElement>("Tag entry 1").value).toBe("alpha");
    expect(screen.getByLabelText<HTMLInputElement>("Tag entry 2").value).toBe("beta");
  });

  it("keeps the rest of the list unchanged when one entry is edited", async () => {
    render(<Example initial={["alpha", "beta"]} />);
    await userEvent.type(screen.getByLabelText("Tag entry 1"), "!");
    expect(screen.getByLabelText<HTMLInputElement>("Tag entry 1").value).toBe("alpha!");
    expect(screen.getByLabelText<HTMLInputElement>("Tag entry 2").value).toBe("beta");
  });

  it("adds an empty entry, and removes the chosen entry", async () => {
    render(<Example initial={["alpha", "beta"]} />);
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByLabelText<HTMLInputElement>("Tag entry 3").value).toBe("");

    await userEvent.click(screen.getByRole("button", { name: "Remove Tag entry 1" }));
    expect(screen.getByLabelText<HTMLInputElement>("Tag entry 1").value).toBe("beta");
    expect(screen.queryByLabelText("Tag entry 3")).toBeNull();
  });

  it("shows only the Add button when the list is empty", () => {
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

  it("is toggled by a click on the label beside it", async () => {
    render(<Example />);
    expect(screen.getByLabelText<HTMLInputElement>("Verbose").checked).toBe(false);
    await userEvent.click(screen.getByText("Verbose"));
    expect(screen.getByLabelText<HTMLInputElement>("Verbose").checked).toBe(true);
  });
});

describe("Switch", () => {
  function Example({ disabled = false }: { readonly disabled?: boolean }) {
    const [on, setOn] = useState(false);
    return <Switch aria-label="Enabled" checked={on} onCheckedChange={setOn} disabled={disabled} />;
  }

  it("has the switch role, its label as its name, and its state in aria-checked", () => {
    render(<Example />);
    expect(screen.getByRole("switch", { name: "Enabled" }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("toggles on each click, and is not a submit button", async () => {
    render(<Example />);
    const control = screen.getByRole("switch", { name: "Enabled" });
    expect(control).toHaveProperty("type", "button");
    await userEvent.click(control);
    expect(control.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(control);
    expect(control.getAttribute("aria-checked")).toBe("false");
  });

  it("toggles with Space and Enter", async () => {
    render(<Example />);
    await userEvent.tab();
    await userEvent.keyboard(" ");
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
  });

  it("ignores clicks while disabled", async () => {
    render(<Example disabled />);
    await userEvent.click(screen.getByRole("switch"));
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
  });

  // A switch keeps focus while its save is in flight, so a keyboard user does
  // not lose their place.
  it("ignores clicks and keys and keeps focus while aria-disabled", async () => {
    const onCheckedChange = vi.fn();
    render(
      <Switch
        aria-label="Enabled"
        checked={false}
        onCheckedChange={onCheckedChange}
        aria-disabled
      />,
    );
    await userEvent.tab();
    await userEvent.keyboard(" ");
    await userEvent.click(screen.getByRole("switch"));

    expect(onCheckedChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("switch"));
  });
});
