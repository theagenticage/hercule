/**
 * Controller promotion: tokens, the promotion state that freezes and seals
 * this controller, the transfer the old controller streams, and
 * `hercule promote`, which receives it on the new machine.
 *
 * The preview and the switch the old controller serves live in the controller
 * daemon, because both reach the runners, and the runners domain sits above
 * this one.
 */
export { PromotionService, PromotionServiceLayer } from "./service";
export { PromotionTokens, PromotionTokensLayer } from "./tokens";
export {
  PromotionState,
  PromotionStateLayer,
  buildForwardingPointer,
  createSealedError,
  type GateState,
  type PromotionPhase,
} from "./state";
export { PromotionTransfer, PromotionTransferLayer, NO_PROMOTION_TOKEN } from "./transfer";
export { PromotionTransferRouteLayer } from "./route";
export {
  SWITCH_PATH,
  SwitchRequest,
  TRANSFER_PATH,
  canonicalizeAnnounceAddress,
  type PromotionPreview,
} from "./exchange";
