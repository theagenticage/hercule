/**
 * Returns the sentence for a model a harness does not list for an account.
 * Resolving an entry (its `harness-lacks-model` problem) and writing a profile (the
 * refusal) both use it, so they say the same thing.
 */
export const describeHarnessLacksModel = (
  harnessName: string,
  slug: string,
  accountName: string,
): string =>
  `${harnessName} does not list ${slug} for ${accountName}. Choose another harness or model.`;
