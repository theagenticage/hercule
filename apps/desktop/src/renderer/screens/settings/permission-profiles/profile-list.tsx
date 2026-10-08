import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import { describeProfileUsers } from "@hercule/client-core";
import { MAX_PROFILE_GRANTS, type Profile } from "@hercule/contract";
import { ChevronRightIcon } from "../../../icons/chevron-right";
import { ShieldIcon } from "../../../icons/shield";
import { ProfileUserFace, type PosedProfileUser } from "./profile-user-face";
import "./permission-profiles.css";

/** A profile and the agents and assistants that run on it. */
export interface ProfileListEntry {
  readonly profile: Profile;
  readonly users: ReadonlyArray<PosedProfileUser>;
}

/**
 * The most faces a row stacks. The Used by column is 200px wide, and the
 * names after the faces are what tell users apart, so a profile with many
 * users still draws a short stack.
 */
const MAX_STACKED_FACES = 3;

/**
 * Renders the list of permission profiles (spec 17 §Settings, Permission
 * profiles): a lead and a table with one row per entry, in the order given.
 * Each row links to the profile's page, and shows at most
 * `MAX_STACKED_FACES` faces of its users.
 *
 * The table drops its Used by column below 600px of width, and its shield
 * below 400px, as the book draws it.
 */
export function ProfileList({
  entries,
}: {
  readonly entries: ReadonlyArray<ProfileListEntry>;
}): JSX.Element {
  return (
    <div className="profile-list">
      <p className="profile-lead">
        A profile bounds what a session may do through the API. Every agent and assistant runs on
        one.
      </p>
      <section>
        <div className="profile-list-head">
          <span />
          <span>Profile</span>
          <span>Grants</span>
          <span>Used by</span>
          <span />
        </div>
        {entries.map(({ profile, users }) => (
          <Link
            key={profile.id}
            to="/settings/permission-profiles/$id"
            params={{ id: profile.id }}
            className="profile-row"
          >
            <span className="profile-mark">
              <ShieldIcon size={16} />
            </span>
            <span className="profile-name">
              <b>{profile.name}</b>
              <span>{profile.shipped ? "Shipped with Hercule" : "Made by you"}</span>
            </span>
            <span className="profile-held">
              {`${profile.grants.length} of ${MAX_PROFILE_GRANTS}`}
              <span className="profile-meter">
                <i style={{ width: `${(profile.grants.length / MAX_PROFILE_GRANTS) * 100}%` }} />
              </span>
            </span>
            <span className={users.length === 0 ? "profile-used is-none" : "profile-used"}>
              {users.length > 0 && (
                <span className="profile-faces">
                  {users.slice(0, MAX_STACKED_FACES).map((user) => (
                    <ProfileUserFace key={user.id} user={user} size={24} />
                  ))}
                </span>
              )}
              <span className="profile-used-names">{describeProfileUsers(users)}</span>
            </span>
            <ChevronRightIcon size={14} />
          </Link>
        ))}
      </section>
    </div>
  );
}
