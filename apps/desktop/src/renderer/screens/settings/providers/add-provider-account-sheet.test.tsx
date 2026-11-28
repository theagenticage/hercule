/**
 * Tests the add-account sheet where its markup decides what the user can do:
 * a tile or a kind calls back with its id, Enter in a field presses the main
 * button only when it can be pressed, a machine that can do nothing cannot
 * be picked, and Back, Cancel and Discard are where each screen puts them.
 */
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SignInRunnerOption } from "@hercule/client-core";
import {
  AddProviderAccountSheet,
  type AddAccountPrimaryButton,
  type AddProviderAccountScreen,
} from "./add-provider-account-sheet";

const PRIMARY: AddAccountPrimaryButton = {
  label: "Done",
  disabled: false,
  busy: false,
  onPress: () => undefined,
};

/** Draws the sheet on `screen`; the caller overrides the props the test is about. */
function draw(
  screen: AddProviderAccountScreen,
  props: {
    readonly primary?: AddAccountPrimaryButton | null;
    readonly onBack?: (() => void) | null;
    readonly cancelLabel?: string;
    readonly error?: string | null;
  } = {},
): void {
  render(
    <AddProviderAccountSheet
      dialogRef={createRef()}
      title="Add an account"
      mark={null}
      screen={screen}
      error={props.error ?? null}
      onBack={props.onBack ?? null}
      cancelLabel={props.cancelLabel ?? "Cancel"}
      primary={props.primary === undefined ? PRIMARY : props.primary}
      onClose={() => undefined}
    />,
  );
}

const credentialsScreen = (
  overrides: Partial<Extract<AddProviderAccountScreen, { kind: "credentials" }>> = {},
): AddProviderAccountScreen => ({
  kind: "credentials",
  lead: null,
  fields: [{ name: "apiKey", label: "API key" }],
  values: {},
  errors: {},
  busy: false,
  onChange: () => undefined,
  ...overrides,
});

const option = (
  runnerId: string,
  runnerName: string,
  overrides: Partial<SignInRunnerOption> = {},
): SignInRunnerOption => ({
  runnerId,
  runnerName,
  isController: false,
  action: { kind: "sign-in", reason: null },
  buttonLabel: "Sign in",
  ...overrides,
});

describe("AddProviderAccountSheet", () => {
  it("calls back with the id of the provider whose tile is pressed", async () => {
    const onPick = vi.fn<(providerId: string) => void>();
    draw(
      {
        kind: "provider",
        providers: [
          { id: "anthropic/anthropic", name: "Anthropic", mark: null },
          { id: "zai/zai", name: "Z.ai", mark: null },
        ],
        onPick,
      },
      { primary: null },
    );

    await userEvent.click(screen.getByRole("button", { name: "Z.ai" }));

    expect(onPick).toHaveBeenCalledWith("zai/zai");
  });

  it("calls back with the id of the kind picked, and shows the picked one on", async () => {
    const onPick = vi.fn<(kindId: string) => void>();
    draw({
      kind: "account-kind",
      kinds: [
        {
          id: "subscription-token",
          title: "Claude subscription, every machine",
          description: "A token.",
        },
        {
          id: "subscription-per-machine",
          title: "Claude subscription, signed in on each machine",
          description: "A login.",
        },
      ],
      pickedId: "subscription-token",
      onPick,
    });

    expect(screen.getByRole("radio", { name: /every machine/ })).toHaveProperty("checked", true);
    await userEvent.click(screen.getByRole("radio", { name: /on each machine/ }));

    expect(onPick).toHaveBeenCalledWith("subscription-per-machine");
  });

  it("presses the main button on Enter in a field when it can be pressed", async () => {
    const onPress = vi.fn<() => void>();
    draw(credentialsScreen(), { primary: { ...PRIMARY, onPress } });

    await userEvent.type(screen.getByLabelText("API key"), "{Enter}");

    expect(onPress).toHaveBeenCalledOnce();
  });

  it("does not press the main button on Enter while it is disabled or busy", async () => {
    const onPress = vi.fn<() => void>();
    draw(credentialsScreen(), { primary: { ...PRIMARY, disabled: true, onPress } });
    await userEvent.type(screen.getByLabelText("API key"), "{Enter}");
    expect(onPress).not.toHaveBeenCalled();
  });

  it("shows the error of the last press under the screen", () => {
    draw(credentialsScreen(), { error: "The key was refused." });

    expect(screen.getByRole("alert").textContent).toBe("The key was refused.");
  });

  it("asks for the label with its prompt, and shows a hint until there is an error", () => {
    draw({
      kind: "label",
      prompt: "Give this one a name, so you can tell them apart.",
      value: "",
      placeholder: "Work, Personal, Team…",
      hint: "Shown after the provider, as in Anthropic · Work.",
      error: null,
      busy: false,
      onChange: () => undefined,
    });

    expect(screen.getByText("Give this one a name, so you can tell them apart.")).toBeTruthy();
    expect(screen.getByLabelText("Name")).toBeTruthy();
    expect(screen.getByText("Shown after the provider, as in Anthropic · Work.")).toBeTruthy();
  });

  it("makes the label read-only while busy, so typing changes nothing", async () => {
    const onChange = vi.fn<(label: string) => void>();
    draw({
      kind: "label",
      prompt: "Give this one a name.",
      value: "home",
      placeholder: "Work, Personal, Team…",
      hint: "A hint.",
      error: null,
      busy: true,
      onChange,
    });

    const input = screen.getByLabelText<HTMLInputElement>("Name");
    await userEvent.type(input, "x");

    expect(input.readOnly).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("lets the user pick a machine that can sign in, and not one that cannot", async () => {
    const onChoose = vi.fn<(runnerId: string) => void>();
    draw({
      kind: "sign-in",
      method: "sign-in",
      options: [
        option("moss", "moss", { isController: true }),
        option("kona", "kona"),
        option("atlas", "atlas", {
          action: { kind: "offline", reason: "atlas is offline." },
        }),
      ],
      chosenRunnerId: "moss",
      signedInOn: null,
      onChoose,
    });

    expect(screen.getByText("Runs Hercule")).toBeTruthy();
    expect(screen.getByText("atlas is offline.")).toBeTruthy();
    const atlas = screen.getByRole("radio", { name: /atlas/ });
    expect(atlas).toHaveProperty("disabled", true);
    await userEvent.click(screen.getByRole("radio", { name: /kona/ }));
    expect(onChoose).toHaveBeenCalledWith("kona");
  });

  it("says where the account signed in once it has", () => {
    draw({
      kind: "sign-in",
      method: "create-token",
      options: [option("moss", "moss")],
      chosenRunnerId: "moss",
      signedInOn: "moss",
      onChoose: () => undefined,
    });

    expect(screen.getByText("Signed in on moss")).toBeTruthy();
  });

  it("puts Back before Cancel when there is a step to go back to, and names the cancel button as given", () => {
    const onBack = vi.fn<() => void>();
    draw(credentialsScreen(), { onBack, cancelLabel: "Discard" });

    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "",
      "Back",
      "Discard",
      "Done",
    ]);
  });

  it("shows no Back on the first step and no main button on a screen without one", () => {
    draw({ kind: "provider", providers: [], onPick: () => undefined }, { primary: null });

    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
  });
});
