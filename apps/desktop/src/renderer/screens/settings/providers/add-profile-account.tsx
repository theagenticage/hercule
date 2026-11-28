import type { JSX } from "react";
import type { PluginIdentity } from "@hercule/client-core";
import { PlusIcon } from "../../../icons/plus";
import { usePopoverMenu } from "../../use-popover-menu";
import "../../thread/menus.css";
import { IdentityLine } from "./identity-line";
import type { ProfileAccountChoice } from "./profile-account-choice";
import { ProviderMark } from "./provider-mark";
import "./models.css";

/**
 * Renders the dashed row after the last section of a Model Profile,
 * "Add an account to <profile>", and the menu it opens.
 *
 * The menu lists `choices`, the accounts the profile does not hold, under
 * "Your accounts not in <profile>"; `onJoin` receives the id of the one the
 * user picks. When `choices` is empty it says the profile already uses every
 * account. Its last item, "New account…", calls `onNewAccount`.
 */
export function AddProfileAccount({
  profileName,
  choices,
  plugins,
  onJoin,
  onNewAccount,
}: {
  readonly profileName: string;
  readonly choices: ReadonlyArray<ProfileAccountChoice>;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly onJoin: (providerAccountId: string) => void;
  readonly onNewAccount: () => void;
}): JSX.Element {
  const { triggerProps, menuProps, buildItemProps, close } = usePopoverMenu();
  const label = `Add an account to ${profileName}`;
  const newAccountProps = buildItemProps("new-account");
  return (
    <div className="pm-addwrap">
      <button type="button" className="pm-addacct" {...triggerProps}>
        <PlusIcon size={13} />
        {label}
      </button>
      <div
        {...menuProps}
        popover="auto"
        role="menu"
        aria-label={label}
        className="pop popover-menu pm-addmenu"
      >
        {choices.length === 0 ? (
          <p className="menu-note">{`${profileName} already uses every account you have.`}</p>
        ) : (
          <div role="group" aria-label={`Your accounts not in ${profileName}`}>
            <div className="q-h" aria-hidden="true">{`Your accounts not in ${profileName}`}</div>
            {choices.map((choice) => {
              const item = buildItemProps(choice.providerAccountId);
              return (
                <button
                  key={choice.providerAccountId}
                  type="button"
                  {...item}
                  className={
                    item.className === undefined ? "pm-addchoice" : `${item.className} pm-addchoice`
                  }
                  onClick={() => {
                    close();
                    onJoin(choice.providerAccountId);
                  }}
                >
                  <ProviderMark pluginId={choice.pluginId} plugins={plugins} size={14} />
                  <span className="pm-addchoice-text">
                    <b>{choice.name}</b>
                    <IdentityLine line={choice.identity} className="pm-addchoice-identity" />
                  </span>
                </button>
              );
            })}
          </div>
        )}
        <div className="pm-addmenu-foot">
          <button
            type="button"
            {...newAccountProps}
            onClick={() => {
              close();
              onNewAccount();
            }}
          >
            <PlusIcon size={14} />
            New account…
          </button>
        </div>
      </div>
    </div>
  );
}
