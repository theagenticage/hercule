/**
 * Provider Accounts: one account at one Provider, such as a Claude
 * subscription or a Z.ai key, and what each runner learned about it in each
 * harness it may run in.
 *
 * This is the one domain that still sends frames to runners itself - to sign
 * an account in, probe a runner, or install a harness - instead of leaving
 * that to the controller daemon. It creates no dependency cycle, so it was
 * left as it is; moving it under the same rule is issue #209.
 */
export { isLoggedIn, NO_PLACEMENT, resolveAccountHarness } from "./account-harness";
export type { ResolvedAccountHarness } from "./account-harness";
export { prepareHarnessAccount } from "./harness-account";
export { resolveHarnessHome } from "./harness-home";
export {
  ProviderAccountProbeDeadline,
  ProviderAccountProbeInterval,
  ProviderAccountProbes,
  ProviderAccountProbesLayer,
} from "./probes";
export {
  providerAccountRepository,
  type StoredProviderAccount,
  type StoredSnapshot,
} from "./repository";
export { seedProviderAccounts } from "./seed";
export {
  describeAccount,
  ProviderAccountService,
  ProviderAccountServiceLayer,
  ProviderAccountSignInDeadline,
  type InstallInput,
  type ProbeInput,
  type SignInCodeInput,
  type SignInInput,
  type UpdateInput,
} from "./service";
