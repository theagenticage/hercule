/**
 * PROTOTYPE (#448). The sidebar's Assistants section, after the threads, as
 * the book's crew.js draws it: each assistant's face, name and presence.
 */
import type { JSX } from "react";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { describePose } from "@hercule/client-core";
import { Face } from "../../faces";
import { ADA, ASSISTANTS } from "./fixture";
import { usePrototype } from "./prototype-state";

export function AssistantsSection(): JSX.Element {
  const router = useRouter();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { adaPose } = usePrototype();
  return (
    <section className="side-sec side-sec--who">
      <h3 className="side-h">
        <span>Assistants</span>
      </h3>
      {ASSISTANTS.map((who) => {
        const path = `/assistants/${who.id}`;
        const pose = who === ADA ? (adaPose ?? who.pose) : who.pose;
        const isOn = pathname === path;
        return (
          <a
            key={who.id}
            className={isOn ? "side-row side-row--who is-on" : "side-row side-row--who"}
            href={`#${path}`}
            aria-current={isOn ? "page" : undefined}
            onClick={(event) => {
              event.preventDefault();
              router.history.push(path);
            }}
          >
            <Face look={who.look} pose={pose} size={22} />
            <span className="side-name">{who.name}</span>
            <span
              className={
                pose === "waiting" ? "side-end side-presence you-ink" : "side-end side-presence"
              }
            >
              {describePose(pose)}
            </span>
          </a>
        );
      })}
    </section>
  );
}
