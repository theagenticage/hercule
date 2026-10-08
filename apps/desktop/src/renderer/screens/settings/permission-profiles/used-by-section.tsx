import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import { ProfileUserFace, type PosedProfileUser } from "./profile-user-face";
import "./permission-profiles.css";

/**
 * Renders the Used by section of a profile's page: the agents and assistants
 * that run on the profile `profileName`, read-only. Each row has the face,
 * the name, and "Agent" or "Assistant". The profile of an assistant is
 * changed on Assistants, which the lead links to.
 */
export function UsedBySection({
  profileName,
  users,
}: {
  readonly profileName: string;
  readonly users: ReadonlyArray<PosedProfileUser>;
}): JSX.Element {
  return (
    <section className="set-sec">
      <h2>Used by</h2>
      <p>
        Change an assistant&apos;s profile on{" "}
        <Link to="/settings/assistants" className="link">
          Assistants
        </Link>
        .
      </p>
      {users.length === 0 ? (
        <div className="profile-none">No agent or assistant uses {profileName}.</div>
      ) : (
        users.map((user) => (
          <div key={user.id} className="profile-user">
            <ProfileUserFace user={user} size={30} />
            <div className="set-label">
              <b>{user.name}</b>
              <span>{user.kind === "assistant" ? "Assistant" : "Agent"}</span>
            </div>
          </div>
        ))
      )}
    </section>
  );
}
