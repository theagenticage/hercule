/**
 * The first run's last screen, All set: what each step left behind, and the
 * way into the app. Presentational.
 */
import type { JSX, ReactNode } from "react";
import type { AllSetRecap, FirstRunStep } from "@hercule/client-core";
import { buildLook, Face, UserAvatar } from "../../faces";
import { QuestionIcon } from "../../icons/question";
import { GitHubMark, LogoMark } from "../../logos";
import type { ProjectTint } from "../project-tile";
import "../project-tile.css";
import { Warning } from "../step";
import { ProviderLogo } from "../thread/provider-logo";

/**
 * Renders All set for `username` in `timezone`, from `recap`. `tint` is the
 * project's tint. A step with nothing to show links back to it with Do it
 * now, through `onDoItNow`. Every other button calls `onLeave`, which opens
 * the new project's draft. `error` is why the last leave failed, or null.
 *
 * Without a logged-in provider, no agent can take a desk, so the main button
 * is Log in to a provider and Open Hercule is the quiet one. Both open the
 * draft, whose own Log in button is where the user logs in.
 */
export function AllSet({
  username,
  timezone,
  recap,
  tint,
  error,
  onDoItNow,
  onLeave,
}: {
  readonly username: string;
  readonly timezone: string;
  readonly recap: AllSetRecap;
  readonly tint: ProjectTint | null;
  readonly error: string | null;
  readonly onDoItNow: (step: FirstRunStep) => void;
  readonly onLeave: () => void;
}): JSX.Element {
  const { project } = recap;
  const projectName = project?.name ?? "your project";
  const doItNow = (step: FirstRunStep): JSX.Element => (
    <button type="button" className="link" onClick={() => onDoItNow(step)}>
      Do it now
    </button>
  );
  return (
    <>
      <div className="fr-newbie">
        <span className="fr-newbie-face">
          {recap.providerNames === null ? (
            <LogoMark size={30} />
          ) : (
            <Face look={buildLook(`New thread in ${projectName}`)} pose="idle" size={46} />
          )}
        </span>
        <span>
          <p className="st-kicker">All set</p>
          <h1 className="st-h">Your office is open</h1>
        </span>
      </div>
      <p className="st-sub">
        {recap.providerNames === null
          ? "Agents need a provider before they can take a desk. Log in from your first thread’s draft, and it can start."
          : recap.gitHubAccount === null
            ? `Your first colleague is at its desk. It can research, write and plan for ${projectName} now. For code, connect GitHub, then add ${projectName}’s repository.`
            : `Your first colleague is at its desk. Tell it what to do in ${projectName}: it works in its own workspace, and raises its hand when it needs you.`}
      </p>
      <ul className="recap">
        <RecapRow mark={<UserAvatar name={username} size={20} />} name={<b>{username}</b>}>
          <em>{timezone}</em>
        </RecapRow>
        <RecapRow
          mark={
            recap.providerId === null ? null : (
              <ProviderLogo providerId={recap.providerId} size={16} />
            )
          }
          name={<b>{recap.providerNames ?? "No provider yet"}</b>}
        >
          {recap.providerNames === null ? doItNow("providers") : <em>logged in</em>}
        </RecapRow>
        <RecapRow
          mark={<GitHubMark size={16} />}
          name={
            recap.gitHubAccount === null ? (
              <b>GitHub</b>
            ) : (
              <>
                <b>GitHub</b> as {recap.gitHubAccount}
              </>
            )
          }
        >
          {recap.gitHubAccount === null ? doItNow("github") : <em>connected</em>}
        </RecapRow>
        {project === null ? null : (
          <RecapRow
            mark={<span className={`proj proj--${tint ?? "none"}`} />}
            name={<b>{project.name}</b>}
          >
            {project.repository !== null ? (
              <em>{project.repository}</em>
            ) : recap.gitHubAccount === null ? (
              <em className="later">Add its repository after GitHub</em>
            ) : (
              <em>no repository yet</em>
            )}
          </RecapRow>
        )}
      </ul>
      {error === null ? null : <Warning icon={<QuestionIcon size={14} />}>{error}</Warning>}
      <div className="st-actions">
        {recap.providerNames === null ? (
          <>
            <button type="button" className="btn btn--accent btn--lg" onClick={onLeave}>
              Log in to a provider
            </button>
            <button type="button" className="btn btn--quiet" onClick={onLeave}>
              Open Hercule
            </button>
          </>
        ) : (
          <button type="button" className="btn btn--accent btn--lg" onClick={onLeave}>
            Start your first thread
          </button>
        )}
      </div>
    </>
  );
}

/** Renders one row of All set's summary: `mark`, `name`, then `children` at the end. */
function RecapRow({
  mark,
  name,
  children,
}: {
  readonly mark: ReactNode;
  readonly name: ReactNode;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <li>
      <span>{mark}</span>
      <span>{name}</span>
      {children}
    </li>
  );
}
