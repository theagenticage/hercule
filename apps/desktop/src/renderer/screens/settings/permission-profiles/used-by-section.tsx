import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import { ProfileAgentFace, type PosedProfileAgent } from "./profile-agent-face";
import "./permission-profiles.css";

/**
 * Renders the Used by section of a profile's page: the agents, assistants
 * included, that run on the profile `profileName`, read-only. Each row has the face,
 * the name, and "Agent" or "Assistant". The profile of an assistant is
 * changed on Assistants, which the lead links to.
 */
export function UsedBySection({
  profileName,
  agents,
}: {
  readonly profileName: string;
  readonly agents: ReadonlyArray<PosedProfileAgent>;
}): JSX.Element {
  return (
    <section className="set-sec">
      <h2>Used by</h2>
      <p>
        {"Change an assistant's profile on "}
        <Link to="/settings/assistants" className="link">
          Assistants
        </Link>
        .
      </p>
      {agents.length === 0 ? (
        <div className="profile-none">{`No agent or assistant uses ${profileName}.`}</div>
      ) : (
        agents.map((agent) => (
          <div key={agent.id} className="profile-agent">
            <ProfileAgentFace agent={agent} size={30} />
            <div className="set-label">
              <b>{agent.name}</b>
              <span>{agent.kind === "assistant" ? "Assistant" : "Agent"}</span>
            </div>
          </div>
        ))
      )}
    </section>
  );
}
