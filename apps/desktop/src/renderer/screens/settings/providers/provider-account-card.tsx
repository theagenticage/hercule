import type { JSX, ReactNode } from "react";
import type {
  AccountFix,
  AccountState,
  AccountUsageGauge,
  ProviderAccountIdentityLine,
  ProviderAccountReachView,
} from "@hercule/client-core";
import { CheckIcon } from "../../../icons/check";
import { PlusIcon } from "../../../icons/plus";
import { AccountReach } from "./account-reach";
import { AccountStateLine } from "./account-state-line";
import { ProfileFace } from "../../profile-face";
import { UsageGauge } from "./usage-gauge";
import "./providers.css";

/** How an account stands with the Model Profiles, as its card draws it. */
export interface ProfileUse {
  /** The profiles that hold the account, in the profiles' order. */
  readonly holders: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  /** The name of the profile open on the Models section. */
  readonly openName: string;
  /** Whether the open profile holds the account. */
  readonly inOpen: boolean;
  /** Whether there is more than one profile. With one, the card does not draw the faces. */
  readonly severalProfiles: boolean;
  /** Whether adding the account to the open profile is waiting or running. */
  readonly saving: boolean;
  /** The message of the last refused addition to the open profile, or `null`. */
  readonly error: string | null;
}

/**
 * Renders the card of one Provider Account: a button that opens its sheet,
 * holding the provider's `mark` and the account's `name`; under them the
 * `identity` (who is signed in, then the plan, each on a line of its own, or
 * the kind's title alone); and then one of two things:
 *
 * - the account's `state`, when it needs the user: what is wrong, and a
 *   second button under the card that fixes it, which calls `onFix`. The card
 *   takes the state's hue. The fix is a button of its own and not part of the
 *   card's button, because a button cannot hold a button;
 * - else the usage `usage` as a gauge, with when it was read. An account with
 *   no usage has no gauge.
 *
 * `profileUse` is how the account stands with the Model Profiles, or `null`
 * when there is no profile. Under the body is a foot with the faces of the
 * profiles that hold the account at the left (with one profile, the words "Not
 * in the menu" for an account it does not hold) and, at the right, "In
 * <profile>" when the open profile holds it or a button "Use in <profile>"
 * that calls `onUse`. With one profile, an account it holds has no foot. A card
 * the open profile does not hold is drawn dimmed. The button is a sibling of
 * the card's button, so pressing it never opens the sheet.
 *
 * `reach` is where the account works. It sits at the right end of the last
 * line of the identity, which gives way to it, so the reach never shrinks.
 * It is `null` when it is not known where the account works, and the card
 * then draws no reach.
 */
export function ProviderAccountCard({
  mark,
  name,
  identity,
  reach,
  usage,
  state,
  profileUse,
  onOpen,
  onFix,
  onUse,
}: {
  readonly mark: ReactNode;
  readonly name: string;
  readonly identity: ProviderAccountIdentityLine;
  readonly reach: ProviderAccountReachView | null;
  readonly usage: AccountUsageGauge | null;
  readonly state: AccountState;
  readonly profileUse: ProfileUse | null;
  readonly onOpen: () => void;
  readonly onFix: (fix: AccountFix) => void;
  readonly onUse: () => void;
}): JSX.Element {
  const fix = state.kind === "ok" ? null : state.fix;
  const tone = state.kind === "ok" ? null : state.tone;
  const hasProfileFoot = profileUse !== null && (profileUse.severalProfiles || !profileUse.inOpen);
  const classes = [
    "pa-card",
    tone === null ? null : `is-${tone}`,
    profileUse === null ? null : profileUse.inOpen ? "is-member" : "is-out",
  ];
  return (
    <div className={classes.filter(Boolean).join(" ")}>
      <button
        type="button"
        className={fix === null && !hasProfileFoot ? "pa-card-open" : "pa-card-open has-foot"}
        title={`Open ${name}`}
        onClick={onOpen}
      >
        <span className="pa-card-top">
          {mark}
          <b>{name}</b>
        </span>
        <CardIdentity identity={identity} reach={reach} />
        {state.kind !== "ok" ? (
          <AccountStateLine state={state} />
        ) : (
          usage !== null && <UsageGauge usage={usage} />
        )}
      </button>
      {fix !== null && tone !== null && (
        <div className="pa-card-foot">
          <button type="button" className={`pa-card-fix is-${tone}`} onClick={() => onFix(fix)}>
            {fix.label}
          </button>
        </div>
      )}
      {profileUse !== null && hasProfileFoot && <ProfileFoot use={profileUse} onUse={onUse} />}
    </div>
  );
}

/**
 * Renders the identity of a card on a line for each part: who is signed in,
 * then the plan. An account with no identity has one line, the kind's title.
 * The account's `reach` is at the right end of the last line.
 */
function CardIdentity({
  identity,
  reach,
}: {
  readonly identity: ProviderAccountIdentityLine;
  readonly reach: ProviderAccountReachView | null;
}): JSX.Element {
  const { text, plan } = identity;
  return (
    <>
      <CardLine text={text} reach={plan === null ? reach : null} />
      {plan !== null && <CardLine text={plan} reach={reach} />}
    </>
  );
}

/**
 * Renders one line of a card's identity. The text ends in an ellipsis when it
 * is too long and has its full text as its tooltip. When the line has a
 * `reach`, the reach is at its right end and the text gives way to it first,
 * so the reach never shrinks.
 */
function CardLine({
  text,
  reach,
}: {
  readonly text: string;
  readonly reach: ProviderAccountReachView | null;
}): JSX.Element {
  if (reach === null) {
    return (
      <span className="pa-card-line" title={text}>
        {text}
      </span>
    );
  }
  return (
    <span className="pa-card-line pa-card-last">
      <span className="pa-card-last-text" title={text}>
        {text}
      </span>
      <AccountReach reach={reach} />
    </span>
  );
}

/**
 * Renders the foot of a card that tells which profiles use the account: see
 * `ProviderAccountCard`. A refused addition shows under the foot.
 */
function ProfileFoot({
  use,
  onUse,
}: {
  readonly use: ProfileUse;
  readonly onUse: () => void;
}): JSX.Element {
  const names = use.holders.map(({ name }) => name).join(", ");
  return (
    <div className="pa-card-profiles">
      <div className="pa-card-foot">
        {use.severalProfiles && use.holders.length > 0 ? (
          <span className="pa-card-faces" role="img" aria-label={`Used in ${names}`} title={names}>
            {use.holders.map(({ id, name }) => (
              <ProfileFace key={id} name={name} size="xs" />
            ))}
          </span>
        ) : (
          <span className="pa-card-out">
            {use.severalProfiles ? "No profile yet" : "Not in the menu"}
          </span>
        )}
        {use.inOpen ? (
          <span className="pa-card-in">
            <CheckIcon size={11} />
            {`In ${use.openName}`}
          </span>
        ) : (
          <button type="button" className="pa-card-use" disabled={use.saving} onClick={onUse}>
            <PlusIcon size={11} />
            {use.saving ? "Adding…" : use.severalProfiles ? `Use in ${use.openName}` : "Use"}
          </button>
        )}
      </div>
      {use.error === null ? null : (
        <p className="pa-card-err" role="alert">
          {use.error}
        </p>
      )}
    </div>
  );
}
