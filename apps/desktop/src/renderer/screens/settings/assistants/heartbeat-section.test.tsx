/**
 * Tests the Heartbeat section: the switch, the interval, the window's start
 * and end, a schedule set outside the app, the prompt, and the lines under
 * the lead.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Heartbeat } from "@hercule/contract";
import { HeartbeatSection } from "./heartbeat-section";

const HEARTBEAT: Heartbeat = {
  enabled: true,
  schedule: "0 7-23 * * *",
  timezone: "Europe/Amsterdam",
  prompt: "Check in.",
  target: "web",
};

const renderSection = (
  heartbeat: Heartbeat = HEARTBEAT,
  unknownTimezone: string | null = null,
  promptError: string | null = null,
) => {
  const onSave = vi.fn<(change: Partial<Heartbeat>) => void>();
  const onSavePrompt = vi.fn<(prompt: string) => void>();
  render(
    <HeartbeatSection
      assistantName="Ada"
      heartbeat={heartbeat}
      nowMinutes={9 * 60 + 41}
      nowTimezone={unknownTimezone === null ? "Europe/Amsterdam" : "UTC"}
      unknownTimezone={unknownTimezone}
      error={null}
      onSave={onSave}
      promptError={promptError}
      onSavePrompt={onSavePrompt}
    />,
  );
  return { onSave, onSavePrompt };
};

/** Replaces the text of the time field named `name` and commits it by leaving the field. */
const commitTime = async (name: string, text: string): Promise<void> => {
  const field = screen.getByRole("textbox", { name });
  await userEvent.clear(field);
  await userEvent.type(field, text);
  await userEvent.tab();
};

describe("the Heartbeat section", () => {
  it("draws the window and now on the day", () => {
    renderSection();
    expect(
      screen.getByRole("img", { name: "Heartbeat window from 07:00 to 23:00, now 09:41" }),
    ).toBeTruthy();
  });

  it("saves the switch", async () => {
    const { onSave } = renderSection();
    await userEvent.click(screen.getByRole("switch", { name: "Heartbeat" }));
    expect(onSave).toHaveBeenCalledWith({ enabled: false });
  });

  it("saves a new interval as the schedule it builds", async () => {
    const { onSave } = renderSection();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Interval" }), "3 h");
    expect(onSave).toHaveBeenCalledWith({ schedule: "0 7-22/3 * * *" });
  });

  it("saves a new start, with its minute for every beat", async () => {
    const { onSave } = renderSection();
    await commitTime("From", "08:30");
    expect(onSave).toHaveBeenCalledWith({ schedule: "30 8-23 * * *" });
  });

  it("saves a new end", async () => {
    const { onSave } = renderSection();
    await commitTime("To", "21:00");
    expect(onSave).toHaveBeenCalledWith({ schedule: "0 7-21 * * *" });
  });

  it("reverts a time that is not a time, with an error", async () => {
    const { onSave } = renderSection();
    await commitTime("From", "7am");
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "From" })).toHaveProperty("value", "07:00");
    expect(screen.getByRole("alert").textContent).toMatch(/"7am" is not a time/);
  });

  it("reverts an end at another minute, with an error", async () => {
    const { onSave } = renderSection();
    await commitTime("To", "21:15");
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "To" })).toHaveProperty("value", "23:00");
    expect(screen.getByRole("alert").textContent).toMatch(/write 21:00/);
  });

  it("reverts an end that is not a beat, naming the last beat before it", async () => {
    const { onSave } = renderSection({ ...HEARTBEAT, schedule: "0 7-22/3 * * *" });
    await commitTime("To", "21:00");
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/last beat before it is at 19:00/);
  });

  it("shows a schedule set outside the app as its expression, and replaces it when an interval is chosen", async () => {
    const weekdays = { ...HEARTBEAT, schedule: "0 9 * * 1-5" };
    const { onSave } = renderSection(weekdays);
    expect(screen.getByText("0 9 * * 1-5")).toBeTruthy();
    expect(screen.getByText(/Set outside the app/)).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "From" })).toBeNull();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Interval" }), "2 h");
    expect(onSave).toHaveBeenCalledWith({ schedule: "0 7-23/2 * * *" });
  });

  it("saves the prompt when it loses focus, only when it changed", async () => {
    const { onSavePrompt } = renderSection();
    const prompt = screen.getByRole("textbox", { name: "Prompt" });
    await userEvent.click(prompt);
    await userEvent.tab();
    expect(onSavePrompt).not.toHaveBeenCalled();
    await userEvent.type(prompt, " Be brief.");
    await userEvent.tab();
    expect(onSavePrompt).toHaveBeenCalledWith("Check in. Be brief.");
  });

  it("saves the prompt on Cmd+Enter", async () => {
    const { onSavePrompt } = renderSection();
    const prompt = screen.getByRole("textbox", { name: "Prompt" });
    await userEvent.type(prompt, "!{Meta>}{Enter}{/Meta}");
    expect(onSavePrompt).toHaveBeenCalledWith("Check in.!");
    expect(document.activeElement).not.toBe(prompt);
  });

  it("puts the saved prompt back on Esc", async () => {
    const { onSavePrompt } = renderSection();
    const prompt = screen.getByRole("textbox", { name: "Prompt" });
    await userEvent.type(prompt, " Be brief.{Escape}");
    expect(prompt).toHaveProperty("value", "Check in.");
    await userEvent.tab();
    expect(onSavePrompt).not.toHaveBeenCalled();
  });

  it("shows a failed prompt save under the Prompt row, not under the schedule", () => {
    renderSection(HEARTBEAT, null, "Could not save: The database is locked.");
    const error = screen.getByRole("alert");
    expect(error.textContent).toBe("Could not save: The database is locked.");
    // The error sits right under the Prompt row.
    expect(
      error.previousElementSibling?.contains(screen.getByRole("textbox", { name: "Prompt" })),
    ).toBe(true);
  });

  it("widens a once-a-day window when a shorter interval is chosen", async () => {
    const { onSave } = renderSection({ ...HEARTBEAT, schedule: "0 9 * * *" });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Interval" }), "3 h");
    expect(onSave).toHaveBeenCalledWith({ schedule: "0 9-21/3 * * *" });
  });

  it("refuses a start that leaves one beat a day", async () => {
    const { onSave } = renderSection({ ...HEARTBEAT, schedule: "0 7-22/3 * * *" });
    await commitTime("From", "21:00");
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "From" })).toHaveProperty("value", "07:00");
    expect(screen.getByRole("alert").textContent).toMatch(/leaves one beat a day/);
  });

  it("clears a refused time's error when the switch saves", async () => {
    const { onSave } = renderSection();
    await commitTime("From", "7am");
    expect(screen.getByRole("alert")).toBeTruthy();
    await userEvent.click(screen.getByRole("switch", { name: "Heartbeat" }));
    expect(onSave).toHaveBeenCalledWith({ enabled: false });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("clears a refused time's error when the prompt saves", async () => {
    renderSection();
    await commitTime("From", "7am");
    expect(screen.getByRole("alert")).toBeTruthy();
    await userEvent.type(screen.getByRole("textbox", { name: "Prompt" }), "!");
    await userEvent.tab();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says the heartbeat is saved but not run yet", () => {
    renderSection();
    expect(screen.getByText(/does not start heartbeats/)).toBeTruthy();
  });

  it("names a time zone this Mac does not know, and the zone now is read in", () => {
    renderSection({ ...HEARTBEAT, timezone: "Mars/Olympus" }, "Mars/Olympus");
    expect(
      screen.getByText(
        "This Mac does not know the zone Mars/Olympus; the timeline shows now in UTC.",
      ),
    ).toBeTruthy();
  });
});
