/**
 * The controller daemon: the layer above the domains. It is the only module
 * that sends frames to runners and the only consumer of what they report, so a
 * domain below it holds rows and their rules and reaches for nothing else. The
 * providers domain is the last exception, still sending its own frames; issue
 * #209 brings it under the same rule.
 *
 * One file per use case, beside a shared helper or two (`absorbing.ts`,
 * `resuming.ts`), and a use case is anything that sequences a write set across
 * domains together with a message to a machine.
 *
 * Where a check shared by two use cases lives follows what it reads: one over a
 * single domain's own rows belongs to that domain (`providers/resolved.ts`),
 * one that reads across domains belongs here (`resuming.ts`).
 */
export { DispatchLayer } from "./dispatch";
export { Inbound, InboundLayer } from "./inbound";
export { Live, LiveLayer, SessionInputDeadline } from "./live";
export { Matcher, MatcherLayer } from "./matching";
export { Placement, PlacementLayer } from "./placement";
export { ProfileRemoval, ProfileRemovalLayer } from "./profile-removal";
export { Provisioning, ProvisioningLayer, WorkspaceSweepInterval } from "./provisioning";
export { Retirement, RetirementLayer } from "./retirement";
