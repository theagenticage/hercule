/**
 * The Provider field of Settings > Assistants: one menu that picks both the
 * Provider Account an assistant runs on and the model it uses there.
 */
import {
  toIdTail,
  type ModelProfile,
  type Provider,
  type ProviderAccount,
} from "@hercule/contract";
import { listProfileEntries } from "../model-profiles/profile-entries";
import { buildProviderAccountName, resolveThreadHarnessId } from "../provider-accounts";
import type { AssistantDraft } from "./form";

/** One choice in the Provider field: an account and a model on it. */
interface AssistantProviderChoice {
  readonly providerAccountId: string;
  /**
   * The harness the choice runs in: the assistant's own harness for its own
   * account, else `null` for the account's default harness.
   */
  readonly harnessId: string | null;
  /** The model's slug, or `null` for the account's default model. */
  readonly model: string | null;
  /** The choice's text, such as `Anthropic · Sonnet 5`. */
  readonly label: string;
}

/** The choices of one Provider Account, shown as one group of the menu. */
interface AssistantProviderGroup {
  readonly providerAccountId: string;
  readonly label: string;
  readonly choices: readonly AssistantProviderChoice[];
}

interface AssistantProviderField {
  readonly groups: readonly AssistantProviderGroup[];
  /** The harness the assistant runs in, for its logo, or `null` when its account is gone. */
  readonly harnessId: string | null;
  /**
   * The identity the assistant's account is signed in as, else the account's
   * name, or "" when the account is gone.
   */
  readonly hint: string;
}

/**
 * Builds the Provider field for `assistant`, the account and model it runs
 * on, from every Provider Account.
 *
 * Each account is one group: first its default model, then each model the
 * Model Profiles list for it in the harness the assistant would run in, each
 * once, in profile order. A client reads no Model Catalog outside the model
 * picker, so a model no profile lists is not offered here; the assistant's own
 * choice always is.
 *
 * A select whose value matches none of its options shows its first option
 * instead, so the assistant's own choice is always an option:
 * - a model the catalog does not offer, or that a signed-out account cannot
 *   list, is added at the end of its account's group;
 * - an account that no longer exists is added as a last group, named by its
 *   id tail and "(not found)", holding only the assistant's choice.
 */
export const buildAssistantProviderField = (
  accounts: readonly ProviderAccount[],
  providers: readonly Provider[],
  modelProfiles: readonly ModelProfile[],
  assistant: Pick<AssistantDraft, "providerAccountId" | "harnessId" | "model">,
): AssistantProviderField => {
  const buildGroup = (
    providerAccountId: string,
    harnessId: string | null,
    label: string,
    slugs: ReadonlyArray<{ readonly slug: string; readonly name: string }>,
  ): AssistantProviderGroup => {
    const models =
      providerAccountId === assistant.providerAccountId &&
      assistant.model !== null &&
      !slugs.some(({ slug }) => slug === assistant.model)
        ? [...slugs, { slug: assistant.model, name: assistant.model }]
        : slugs;
    return {
      providerAccountId,
      label,
      choices: [
        { providerAccountId, harnessId, model: null, label: `${label} · Default model` },
        ...models.map((model) => ({
          providerAccountId,
          harnessId,
          model: model.slug,
          label: `${label} · ${model.name}`,
        })),
      ],
    };
  };

  const findHarnessId = (account: ProviderAccount): string | null =>
    account.id === assistant.providerAccountId ? assistant.harnessId : null;

  const listModels = (
    account: ProviderAccount,
  ): ReadonlyArray<{ readonly slug: string; readonly name: string }> => {
    const harnessId = resolveThreadHarnessId(account, findHarnessId(account));
    const models: Array<{ readonly slug: string; readonly name: string }> = [];
    for (const entry of modelProfiles.flatMap(listProfileEntries)) {
      if (
        entry.providerAccountId === account.id &&
        entry.resolvedHarnessId === harnessId &&
        !models.some(({ slug }) => slug === entry.model)
      ) {
        models.push({ slug: entry.model, name: entry.name });
      }
    }
    return models;
  };

  const groups = accounts.map((account) =>
    buildGroup(
      account.id,
      findHarnessId(account),
      buildProviderAccountName(providers, account),
      listModels(account),
    ),
  );
  const account = accounts.find(({ id }) => id === assistant.providerAccountId);
  if (account === undefined) {
    const { providerAccountId, harnessId, model } = assistant;
    const label = `${toIdTail(providerAccountId)} (not found)`;
    groups.push({
      providerAccountId,
      label,
      choices: [
        {
          providerAccountId,
          harnessId,
          model,
          label: `${label} · ${model ?? "Default model"}`,
        },
      ],
    });
  }
  return {
    groups,
    harnessId: account === undefined ? null : resolveThreadHarnessId(account, assistant.harnessId),
    hint:
      account === undefined
        ? ""
        : (account.identity ?? buildProviderAccountName(providers, account)),
  };
};
