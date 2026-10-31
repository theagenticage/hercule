/**
 * Tests the decisions of the add-account sheet: which questions it asks, in
 * which order, the payload it sends and the machines a sign-in can run on.
 */
import { describe, expect, it } from "vitest";
import type { AccountKind, Provider } from "@hercule/contract";
import {
  ADD_ACCOUNT_LABEL_PROMPT,
  asksForAccountLabel,
  buildProviderAccountCreateInput,
  createsAccountAfterStep,
  isAddAccountStepFilled,
  listSignInRunnerOptions,
  offersKindChoice,
  planAddAccountSteps,
} from "./add-provider-account";
import {
  ANTHROPIC_IDENTITY,
  BARE,
  HARNESSES,
  PROVIDERS,
  WITH_CLAUDE,
  buildProviderAccount,
} from "./providers.testing";

const KEY_KIND: AccountKind = {
  id: "api-key",
  title: "API key",
  description: "A key.",
  setup: [{ kind: "credentials", fields: [{ name: "apiKey", label: "API key" }] }],
  harnesses: ["pi/pi"],
};
const SIGN_IN_KIND: AccountKind = {
  id: "subscription-per-machine",
  title: "Claude subscription, signed in on each machine",
  description: "Sign in on each machine.",
  setup: [{ kind: "harness-login", method: "sign-in" }],
  harnesses: ["claude-code/claude-code"],
};
const TOKEN_KIND: AccountKind = {
  ...SIGN_IN_KIND,
  id: "subscription-token",
  setup: [{ kind: "harness-login", method: "create-token" }],
};

const ANTHROPIC = PROVIDERS[0]!;
const ZAI = PROVIDERS[2]!;
const CLAUDE_CODE = HARNESSES[0]!;
const ATLAS = { ...WITH_CLAUDE, id: "runner-atlas", name: "atlas" };
const MOSS_WITHOUT_CLAUDE = { ...BARE, id: "runner-moss" };

describe("offersKindChoice", () => {
  it("offers a choice only when the provider has more than one kind", () => {
    const withTwoKinds: Provider = { ...ANTHROPIC, kinds: [SIGN_IN_KIND, TOKEN_KIND] };

    expect(offersKindChoice(withTwoKinds)).toBe(true);
    expect(offersKindChoice(ZAI)).toBe(false);
  });
});

describe("asksForAccountLabel", () => {
  it("asks only when the user has an account at that provider already", () => {
    const accounts = [buildProviderAccount(ANTHROPIC_IDENTITY)];

    expect(asksForAccountLabel(accounts, ANTHROPIC)).toBe(true);
    expect(asksForAccountLabel(accounts, ZAI)).toBe(false);
    expect(asksForAccountLabel([], ANTHROPIC)).toBe(false);
  });
});

describe("planAddAccountSteps", () => {
  it("ends a key kind in create, after the key and the label", () => {
    expect(planAddAccountSteps(KEY_KIND, true)).toEqual([
      { kind: "credentials", fields: [{ name: "apiKey", label: "API key" }] },
      { kind: "label", prompt: ADD_ACCOUNT_LABEL_PROMPT },
      { kind: "create" },
    ]);
  });

  it("asks a harness-login kind for its label before it creates the account, and signs in after", () => {
    expect(planAddAccountSteps(SIGN_IN_KIND, true)).toEqual([
      { kind: "label", prompt: ADD_ACCOUNT_LABEL_PROMPT },
      { kind: "create" },
      { kind: "sign-in", method: "sign-in" },
    ]);
    expect(planAddAccountSteps(TOKEN_KIND, false)).toEqual([
      { kind: "create" },
      { kind: "sign-in", method: "create-token" },
    ]);
  });

  it("keeps the kind's instructions first, in the order it declares its steps", () => {
    const kind = {
      setup: [{ kind: "checklist", markdown: "Find the key under Settings." }, ...KEY_KIND.setup],
    } satisfies Pick<AccountKind, "setup">;

    expect(planAddAccountSteps(kind, false).map((step) => step.kind)).toEqual([
      "checklist",
      "credentials",
      "create",
    ]);
  });

  it("leaves out a step the sheet cannot draw", () => {
    expect(planAddAccountSteps({ setup: [{ kind: "oauth" }] }, false)).toEqual([
      { kind: "create" },
    ]);
  });
});

describe("createsAccountAfterStep", () => {
  it("is true for the step just before create", () => {
    const steps = planAddAccountSteps(SIGN_IN_KIND, true);

    expect(steps.map((_, index) => createsAccountAfterStep(steps, index))).toEqual([
      true,
      false,
      false,
    ]);
  });
});

describe("isAddAccountStepFilled", () => {
  const [credentials, label] = planAddAccountSteps(KEY_KIND, true) as [
    ReturnType<typeof planAddAccountSteps>[number],
    ReturnType<typeof planAddAccountSteps>[number],
  ];

  it("needs every field and treats spaces as empty", () => {
    expect(isAddAccountStepFilled(credentials, { label: "", credentials: {} })).toBe(false);
    expect(isAddAccountStepFilled(credentials, { label: "", credentials: { apiKey: "  " } })).toBe(
      false,
    );
    expect(
      isAddAccountStepFilled(credentials, { label: "", credentials: { apiKey: "sk-1" } }),
    ).toBe(true);
  });

  it("needs a label when the label step is asked", () => {
    expect(isAddAccountStepFilled(label, { label: " ", credentials: {} })).toBe(false);
    expect(isAddAccountStepFilled(label, { label: "Work", credentials: {} })).toBe(true);
  });

  it("asks nothing for create and sign-in", () => {
    expect(isAddAccountStepFilled({ kind: "create" }, { label: "", credentials: {} })).toBe(true);
  });
});

describe("buildProviderAccountCreateInput", () => {
  it("sends the trimmed key and label of a key kind", () => {
    expect(
      buildProviderAccountCreateInput("zai/zai", "api-key", planAddAccountSteps(KEY_KIND, true), {
        label: " Work ",
        credentials: { apiKey: "  sk-1\n" },
      }),
    ).toEqual({
      providerId: "zai/zai",
      kind: "api-key",
      label: "Work",
      credentials: { apiKey: "sk-1" },
    });
  });

  it("sends neither credentials nor a label that was not asked for", () => {
    expect(
      buildProviderAccountCreateInput(
        "anthropic/anthropic",
        "subscription-token",
        planAddAccountSteps(TOKEN_KIND, false),
        { label: "left over", credentials: { apiKey: "left over" } },
      ),
    ).toEqual({ providerId: "anthropic/anthropic", kind: "subscription-token" });
  });
});

describe("listSignInRunnerOptions", () => {
  it("lists the controller's runner first and the others in the order given", () => {
    const { options } = listSignInRunnerOptions(
      [ATLAS, WITH_CLAUDE],
      CLAUDE_CODE,
      "sign-in",
      WITH_CLAUDE.id,
    );

    expect(options.map((option) => [option.runnerName, option.isController])).toEqual([
      ["moss", true],
      ["atlas", false],
    ]);
  });

  it("leaves out a retired runner", () => {
    const retired = { ...ATLAS, lifecycle: "retired" as const };

    expect(
      listSignInRunnerOptions([retired, WITH_CLAUDE], CLAUDE_CODE, "sign-in", null).options,
    ).toHaveLength(1);
  });

  it("offers Sign in where the harness is, and Make the token for a token kind", () => {
    const [signIn] = listSignInRunnerOptions([WITH_CLAUDE], CLAUDE_CODE, "sign-in", null).options;
    const [token] = listSignInRunnerOptions(
      [WITH_CLAUDE],
      CLAUDE_CODE,
      "create-token",
      null,
    ).options;

    expect(signIn).toMatchObject({ action: { kind: "sign-in" }, buttonLabel: "Sign in" });
    expect(token).toMatchObject({ action: { kind: "sign-in" }, buttonLabel: "Make the token" });
  });

  it("offers Install where the runner has an adapter but not the harness", () => {
    const [option] = listSignInRunnerOptions(
      [MOSS_WITHOUT_CLAUDE],
      CLAUDE_CODE,
      "sign-in",
      null,
    ).options;

    expect(option).toMatchObject({ action: { kind: "install" }, buttonLabel: "Install" });
  });

  it("says why an offline runner, or one that cannot drive the harness, offers nothing", () => {
    const offline = { ...WITH_CLAUDE, connectivity: "offline" as const };
    const noAdapter = {
      ...MOSS_WITHOUT_CLAUDE,
      name: "old",
      facts: { ...BARE.facts!, adapters: [] },
    };

    const { options } = listSignInRunnerOptions([offline, noAdapter], CLAUDE_CODE, "sign-in", null);

    expect(options.map((option) => option.action)).toEqual([
      { kind: "offline", reason: "moss is offline." },
      { kind: "unavailable", reason: "old runs a Hercule build that cannot run Claude Code." },
    ]);
  });

  it("starts on the first machine that can sign in, else the first that can install", () => {
    const offline = { ...WITH_CLAUDE, id: "runner-off", connectivity: "offline" as const };

    expect(
      listSignInRunnerOptions([MOSS_WITHOUT_CLAUDE, ATLAS], CLAUDE_CODE, "sign-in", null)
        .defaultRunnerId,
    ).toBe("runner-atlas");
    expect(
      listSignInRunnerOptions([offline, MOSS_WITHOUT_CLAUDE], CLAUDE_CODE, "sign-in", null)
        .defaultRunnerId,
    ).toBe("runner-moss");
    expect(listSignInRunnerOptions([offline], CLAUDE_CODE, "sign-in", null).defaultRunnerId).toBe(
      null,
    );
  });
});
