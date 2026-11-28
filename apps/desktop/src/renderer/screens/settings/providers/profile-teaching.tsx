import type { JSX } from "react";
import type { PluginIdentity } from "@hercule/client-core";
import { PlusIcon } from "../../../icons/plus";
import { EmptyProfilePreview } from "./empty-profile-preview";
import { IdentityLine } from "./identity-line";
import type { ProfileAccountChoice } from "./profile-account-choice";
import { ProviderMark } from "./provider-mark";
import "./profile-teaching.css";

/**
 * Renders what an empty Model Profile shows in place of its sections: it
 * teaches how to build the profile's menu, in three numbered steps, with a
 * tile for each account in `choices` and a faint preview of the composer's
 * menu.
 *
 * A tile calls `onJoin` with its account's id. "Or add a new account" calls
 * `onNewAccount`.
 */
export function ProfileTeaching({
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
  return (
    <div className="pm-teach">
      <div className="pm-teach-main">
        <h3>{`Build ${profileName}'s model menu`}</h3>
        <p>
          {`A profile is a model selector you put together yourself: the accounts it pays with, and the models you want from each. When a thread uses ${profileName}, the composer shows exactly that list.`}
        </p>
        <ol className="pm-steps">
          <li className="is-now">
            <i aria-hidden="true">1</i>
            <span>
              <b>Pick an account</b>
              <small>Any of yours. It stays in its other profiles too.</small>
            </span>
          </li>
          <li>
            <i aria-hidden="true">2</i>
            <span>
              <b>Pick its models</b>
              <small>The newest come first; older ones are a search away.</small>
            </span>
          </li>
          <li>
            <i aria-hidden="true">3</i>
            <span>
              <b>In the composer</b>
              <small>{`Open ${profileName} in the composer's menu.`}</small>
            </span>
          </li>
        </ol>
        <div className="pm-tiles">
          {choices.map((choice) => (
            <button
              key={choice.providerAccountId}
              type="button"
              className="pm-tile"
              title={`Add ${choice.name} to ${profileName}`}
              onClick={() => {
                onJoin(choice.providerAccountId);
              }}
            >
              <span className="pm-tile-top">
                <ProviderMark pluginId={choice.pluginId} plugins={plugins} size={15} />
                <b>{choice.name}</b>
                <span className="pm-tile-plus" aria-hidden="true">
                  <PlusIcon size={12} />
                </span>
              </span>
              <IdentityLine line={choice.identity} className="pm-tile-identity" />
            </button>
          ))}
        </div>
        <button type="button" className="pm-newacct" onClick={onNewAccount}>
          <PlusIcon size={12} />
          Or add a new account
        </button>
      </div>
      <EmptyProfilePreview profileName={profileName} />
    </div>
  );
}
