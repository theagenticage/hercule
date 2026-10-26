/**
 * The records of the thread specimen's `?state=long`: the Fix thread after
 * three turns, long enough to fill about three windows of 900 px, so a
 * reviewer can judge how the transcript reads. Its messages hold what agents
 * write: paragraphs of several sentences, headings, bulleted and numbered
 * lists, inline code, a fenced code block and a link.
 *
 * The thread is idle. No Request is open and no input is queued, so the
 * composer is in its plain state and the sidebar draws the Fix thread without
 * its Request. The book draws no such thread, so `pnpm compare:bureau` does
 * not compare it.
 *
 * The turns run at these times, in seconds after 09:02 UTC:
 *
 * - turn 1, 0 to 450: the cause and the fix (the Fix thread's first turn, told at length);
 * - turn 2, 700 to 1010: saved cards, Apple Pay and a dismissed modal;
 * - turn 3, 1500 to 1760: the pull request description and what QA checks.
 */
import { CLAUDE_OPUS } from "./sidebar-fixture";
import type { ThreadScreenRecords } from "./shell-page";
import {
  buildTranscript,
  FIX_SESSION,
  runItem,
  runTool,
  TURN_START,
  type TranscriptStep,
} from "./thread-fixture";

/** Returns `steps` with the turn id of every event that names a turn replaced by `turnId`. */
const assignTurnToSteps = (
  turnId: string,
  steps: ReadonlyArray<TranscriptStep>,
): TranscriptStep[] =>
  steps.map(([seconds, event]) => [seconds, "turnId" in event ? { ...event, turnId } : event]);

/** Returns the steps that open a turn with the user's message `text` at `seconds`. */
const startTurn = (
  turnId: string,
  seconds: number,
  itemId: string,
  text: string,
): TranscriptStep[] => [
  [seconds, { _tag: "turn.started", turnId, model: CLAUDE_OPUS.slug }],
  ...assignTurnToSteps(turnId, runItem([seconds, seconds], itemId, "user_message", { text })),
];

/** Returns the step that ends the turn `turnId` at `seconds`. */
const completeTurn = (turnId: string, seconds: number): TranscriptStep => [
  seconds,
  { _tag: "turn.completed", turnId, state: "completed" },
];

/** The agent's message that names the cause of the failure, before it changes anything. */
const TURN_1_CAUSE = [
  "## What is going wrong",
  "",
  "Found it. Since Stripe SDK v14, `confirmPayment` returns `status: 'requires_action'` for cards " +
    "that need 3‑D Secure, instead of rejecting with a card error. `handlePaymentResult` in " +
    "`src/checkout/payment.ts` only handles `succeeded` and treats every other status as a " +
    'failure, so the shopper sees "Card declined" and the 3‑D Secure modal never opens. The ' +
    "charge itself is fine: the payment intent stays open on Stripe's side, which is why support " +
    "sees no failed charges for these orders.",
  "",
  "This also explains why only EU cards break. Cards issued in the EU fall under strong customer " +
    "authentication, so nearly all of them take the `requires_action` path. The US test cards we " +
    "use in CI never do, which is how the bug got through review. The deploy #1289 diff upgraded " +
    "the SDK and touched no checkout code, so nobody looked at the result handling.",
  "",
  "The relevant function, trimmed to the part that matters:",
  "",
  "```ts",
  "export async function handlePaymentResult(result: PaymentIntentResult) {",
  "  if (result.error) {",
  "    return { kind: 'declined', message: result.error.message ?? 'Card declined' };",
  "  }",
  "  if (result.paymentIntent.status === 'succeeded') {",
  "    return { kind: 'paid', paymentIntentId: result.paymentIntent.id };",
  "  }",
  "  // Everything else, including requires_action, lands here.",
  "  return { kind: 'declined', message: 'Card declined' };",
  "}",
  "```",
  "",
  "Before I change anything, I will do three things:",
  "",
  "- write a test that feeds a `requires_action` result into `handlePaymentResult` and expects " +
    "the modal to open;",
  "- check that `3ds-modal.tsx` can be opened with a client secret alone;",
  "- run the checkout suite once, to see which tests already cover the declined path.",
].join("\n");

/** The agent's message that ends the first turn: what the fix changed, and a link. */
const TURN_1_FIX = [
  "## The fix",
  "",
  "`handlePaymentResult` now has a third outcome. When Stripe reports `requires_action`, it passes " +
    "the client secret to `openThreeDSModal` and waits until the shopper finishes the challenge. " +
    "The modal calls `stripe.handleNextAction`, and the payment intent it resolves with goes back " +
    "through `handlePaymentResult`, so a successful challenge ends in the same `paid` outcome as a " +
    "card that needed no challenge. A failed challenge ends in the normal `declined` outcome, with " +
    "the message Stripe gives for it.",
  "",
  "The change touches three files:",
  "",
  "1. `src/checkout/payment.test.ts` has the new test. It failed before the fix with " +
    '"Card declined", which is what the shopper saw.',
  "2. `src/checkout/payment.ts` has the new `requires_action` branch, in front of the fallback.",
  "3. `src/checkout/3ds-modal.tsx` now resolves with the payment intent after the challenge " +
    "instead of closing silently.",
  "",
  "All 41 tests in the checkout suite pass. The branch is `fix/3ds-eu-cards`. For the full list " +
    "of statuses a payment intent can have, see the " +
    "[Stripe docs on payment intent statuses](https://docs.stripe.com/payments/paymentintents/lifecycle).",
].join("\n");

/** The agent's answer about saved cards, Apple Pay and a dismissed modal. */
const TURN_2_COVERAGE = [
  "## Saved cards and Apple Pay",
  "",
  "Saved cards go through the same `confirmPayment` call as new cards, so they now take the same " +
    "branch. I checked `src/checkout/saved-cards.ts` and it does not look at the status itself; " +
    "it passes the result straight to `handlePaymentResult`. That means no change is needed there, " +
    "and the new test covers it, because the test builds the result the same way for both.",
  "",
  "Apple Pay is different. It uses the payment request button, which confirms the payment in " +
    "Apple's own sheet, and Stripe has already completed any authentication by the time our " +
    "code sees the result. `src/checkout/apple-pay.ts` only ever sees `succeeded` or an error, so " +
    "it cannot reach the new branch. I left it alone, and added a comment that explains why, so " +
    "the next person to read it does not wonder.",
  "",
  "One more case was not handled before, and is now. When the shopper closes the modal without " +
    "finishing, `stripe.handleNextAction` rejects with a `payment_intent_authentication_failure` " +
    "error. I now catch that error and return a `cancelled` outcome. The checkout form stays " +
    "filled in and shows no error banner, because the shopper chose to stop and a red message " +
    "would tell them something went wrong when nothing did.",
].join("\n");

/** The agent's message that ends the second turn: the outcomes and a list of them. */
const TURN_2_RESULT = [
  "The new test for the dismissed modal passes, and so does the rest of the suite. These are the " +
    "outcomes `handlePaymentResult` can now return:",
  "",
  "- `paid`: the intent is `succeeded`, with or without a challenge;",
  "- `declined`: Stripe returned an error, or the challenge failed;",
  "- `cancelled`: the shopper closed the modal before the challenge ended.",
  "",
  "I did not touch the `CheckoutOutcome` type's consumers. `checkout.tsx` already ignores any " +
    "outcome it has no case for, which is a risk of its own: a new outcome is silently dropped " +
    "there. I added `cancelled` to its `switch` and made the default branch a compile error with " +
    "`satisfies never`, so the next outcome cannot be forgotten.",
].join("\n");

/** The agent's pull request description and the steps QA follows, with a numbered list and a command. */
const TURN_3_DESCRIPTION = [
  "## Pull request description",
  "",
  "**Fix 3‑D Secure checkout for EU cards**",
  "",
  "Since the Stripe SDK v14 upgrade in deploy #1289, `confirmPayment` returns `requires_action` " +
    "for cards that need 3‑D Secure. Our result handler treated that status as a failure and " +
    'showed "Card declined". It now opens the 3‑D Secure modal, waits for the challenge, and ' +
    "reports the final result. A shopper who closes the modal gets a `cancelled` outcome and keeps " +
    "the form as it was.",
  "",
  "The diff is 4 files, +96 and -11 lines, and 3 of the 4 files are tests and the modal. The " +
    "handler change itself is 14 lines. Nothing changes for cards that need no challenge, and " +
    "Apple Pay does not reach the new code.",
  "",
  "## What QA should check on staging",
  "",
  "1. Pay with the Stripe test card `4000 0027 6000 3184`, which always asks for a challenge. " +
    "The modal opens, and the order is placed after you complete it.",
  "2. Repeat with the card `4000 0082 6000 3178`, which fails the challenge. The checkout shows " +
    "the card error and the form keeps its values.",
  "3. Open the modal and close it with the cross. The form stays filled in and shows no error.",
  "4. Pay with a saved card that needs a challenge. It should behave like a new card.",
  "5. Pay with Apple Pay on a device that has it. Nothing should look different.",
  "",
  "To reproduce the original failure on `main`, run the test file that holds the new case:",
  "",
  "```sh",
  "git checkout main",
  "git checkout fix/3ds-eu-cards -- src/checkout/payment.test.ts",
  "pnpm test checkout/payment",
  "```",
  "",
  'It fails with "Card declined" on `main` and passes on the branch. I have not pushed anything ' +
    "yet. Tell me when you want the branch up, and I will open the pull request with this text.",
].join("\n");

/** The Fix thread's three turns, as transcript steps. */
const LONG_STEPS: ReadonlyArray<TranscriptStep> = [
  ...startTurn(
    "turn-1",
    0,
    "long-ask-1",
    "Checkout fails for EU cards that need 3‑D Secure since deploy #1289. Find the cause " +
      "and fix it. Add a test that reproduces it first.",
  ),
  ...assignTurnToSteps("turn-1", [
    ...runTool([5, 6], "long-read-1", "file_read", "Read", {
      file_path: "src/checkout/payment.ts",
    }),
    ...runTool([12, 13], "long-read-2", "file_read", "Read", {
      file_path: "src/checkout/stripe.ts",
    }),
    ...runTool([20, 21], "long-read-3", "file_read", "Read", {
      file_path: "src/checkout/3ds-modal.tsx",
    }),
    ...runTool([31, 32], "long-read-4", "file_read", "Read", {
      file_path: "src/checkout/checkout.tsx",
    }),
    ...runTool([45, 46], "long-read-5", "file_read", "Read", { file_path: "package.json" }),
    ...runTool([70, 74], "long-log", "command_execution", "Bash", {
      command: "git log --oneline -5 -- src/checkout",
    }),
    ...runItem([134, 140], "long-cause", "assistant_message", undefined, TURN_1_CAUSE),
    ...runTool([145, 150], "long-test", "file_change", "Write", {
      file_path: "src/checkout/payment.test.ts",
    }),
    ...runTool([160, 175], "long-test-run-1", "command_execution", "Bash", {
      command: "pnpm test checkout/payment",
    }),
    ...runTool([190, 195], "long-fix", "file_change", "Edit", {
      file_path: "src/checkout/payment.ts",
    }),
    ...runTool([210, 215], "long-modal", "file_change", "Edit", {
      file_path: "src/checkout/3ds-modal.tsx",
    }),
    ...runTool([230, 300], "long-test-run-2", "command_execution", "Bash", {
      command: "pnpm test checkout",
    }),
    ...runItem([431, 434], "long-fixed", "assistant_message", undefined, TURN_1_FIX),
  ]),
  completeTurn("turn-1", 450),
  ...startTurn(
    "turn-2",
    700,
    "long-ask-2",
    "Good. Does this also cover saved cards and the Apple Pay path? And what happens when the " +
      "shopper closes the modal without finishing?",
  ),
  ...assignTurnToSteps("turn-2", [
    ...runTool([710, 711], "long-read-6", "file_read", "Read", {
      file_path: "src/checkout/saved-cards.ts",
    }),
    ...runTool([720, 721], "long-read-7", "file_read", "Read", {
      file_path: "src/checkout/apple-pay.ts",
    }),
    ...runTool([730, 733], "long-grep", "command_execution", "Bash", {
      command: "grep -rn handlePaymentResult src",
    }),
    ...runItem([800, 806], "long-coverage", "assistant_message", undefined, TURN_2_COVERAGE),
    ...runTool([820, 826], "long-edit-cancel", "file_change", "Edit", {
      file_path: "src/checkout/payment.ts",
    }),
    ...runTool([840, 846], "long-edit-switch", "file_change", "Edit", {
      file_path: "src/checkout/checkout.tsx",
    }),
    ...runTool([860, 870], "long-comment", "file_change", "Edit", {
      file_path: "src/checkout/apple-pay.ts",
    }),
    ...runTool([900, 960], "long-test-run-3", "command_execution", "Bash", {
      command: "pnpm test checkout",
    }),
    ...runItem([1000, 1004], "long-outcomes", "assistant_message", undefined, TURN_2_RESULT),
  ]),
  completeTurn("turn-2", 1010),
  ...startTurn(
    "turn-3",
    1500,
    "long-ask-3",
    "Write the pull request description, and list what QA should check on staging.",
  ),
  ...assignTurnToSteps("turn-3", [
    ...runTool([1510, 1512], "long-diff", "command_execution", "Bash", {
      command: "git diff --stat main...HEAD",
    }),
    ...runTool([1520, 1522], "long-log-2", "command_execution", "Bash", {
      command: "git log --oneline main..HEAD",
    }),
    ...runItem(
      [1750, 1756],
      "long-description",
      "assistant_message",
      undefined,
      TURN_3_DESCRIPTION,
    ),
  ]),
  completeTurn("turn-3", 1760),
];

/**
 * The Fix thread after three finished turns, for the thread specimen's
 * `?state=long`. It waits on nothing: the session is idle and its last
 * activity is the end of the third turn.
 */
export const FIX_THREAD_LONG: ThreadScreenRecords = {
  session: {
    ...FIX_SESSION,
    status: "idle",
    openRequests: [],
    lastActivityAt: new Date(TURN_START + 1760 * 1000).toISOString(),
  },
  transcript: buildTranscript(LONG_STEPS),
  queuedInputs: [],
};
