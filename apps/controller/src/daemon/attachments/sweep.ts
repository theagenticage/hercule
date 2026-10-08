/**
 * The periodic sweep of attachments no input claimed in time.
 *
 * The rule itself is `AttachmentService.sweep`: which rows and files go, and
 * in what order. This module only repeats it.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { AttachmentService } from "../../attachments";
import { absorbFailures } from "../absorbing";

/**
 * How often the sweep runs. An unclaimed upload can no longer be claimed
 * once it is a day old, so up to an hour more before its file goes changes
 * nothing for the user.
 */
const ATTACHMENT_SWEEP_INTERVAL: Duration.Duration = Duration.hours(1);

/** The sweep interval. Tests override it with a shorter one. */
export const AttachmentSweepInterval = Context.Reference<Duration.Duration>(
  "hercule/controller/daemon/AttachmentSweepInterval",
  { defaultValue: (): Duration.Duration => ATTACHMENT_SWEEP_INTERVAL },
);

/**
 * Runs the attachment sweep at once, then every `AttachmentSweepInterval`.
 * Never returns. A pass that fails is logged, and the next one runs.
 */
export const runAttachmentSweepLoop: Effect.Effect<never, never, AttachmentService> = Effect.gen(
  function* () {
    const attachments = yield* AttachmentService;
    const interval = yield* AttachmentSweepInterval;
    while (true) {
      yield* absorbFailures("Sweeping unclaimed attachments failed", attachments.sweep);
      yield* Effect.sleep(interval);
    }
  },
);
