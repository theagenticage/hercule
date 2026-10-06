/**
 * PROTOTYPE (#448). The rail: what an assistant keeps between turns. Its
 * Heartbeat, its reminders and its Memory, as the book's assistant page
 * draws them beside the Conversation.
 */
import { useState, type CSSProperties, type JSX } from "react";
import type { Beat, PrototypeAssistant, Reminder } from "./fixture";
import { ADA_CORE_NOTE, ADA_TOPICS } from "./fixture";
import { AlarmIcon, HeartIcon, MemoryIcon } from "./icons";

const HOURS = Array.from({ length: 17 }, (_, index) => 7 + index);

const describeBeat = (hour: number, beat: Beat): string =>
  `${String(hour).padStart(2, "0")}:00 · ${beat === "future" ? "to come" : beat === "quiet" ? "checked in, stayed quiet" : "spoke"}`;

/** Returns "09:00 spoke · 07:00 and 08:00 quiet · next 10:00" from the beats so far. */
function BeatLine({ beats }: { readonly beats: ReadonlyArray<Beat> }): JSX.Element {
  const at = (index: number): string => `${String(HOURS[index]).padStart(2, "0")}:00`;
  const spoke = beats.flatMap((beat, index) => (beat === "spoke" ? [at(index)] : []));
  const quiet = beats.flatMap((beat, index) => (beat === "quiet" ? [at(index)] : []));
  const next = beats.indexOf("future");
  return (
    <div className="beat-line">
      <b>{spoke.at(-1)}</b> spoke
      {quiet.length === 0 ? null : ` · ${quiet.join(" and ")} quiet`}
      {next === -1 ? null : (
        <>
          {" · next "}
          <b>{at(next)}</b>
        </>
      )}
    </div>
  );
}

export function Rail({
  who,
  beats,
  reminders,
  className = "rail",
}: {
  readonly who: PrototypeAssistant;
  readonly beats: ReadonlyArray<Beat>;
  readonly reminders: ReadonlyArray<Reminder & { readonly fresh?: boolean }>;
  readonly className?: string;
}): JSX.Element {
  const [openTopic, setOpenTopic] = useState<string | null>(null);
  const hue = { "--hue": `var(--hue-${who.look.hue})` } as CSSProperties;
  return (
    <aside className={className} style={hue} aria-label={`What ${who.name} keeps`}>
      <section>
        <h2 className="section-h">
          <HeartIcon size={14} />
          Heartbeat<span className="section-aside">Every hour</span>
        </h2>
        <div className="beat" role="img" aria-label="Heartbeats from 07:00 to 23:00">
          {beats.map((beat, index) => (
            <i
              key={HOURS[index]}
              className={beat === "spoke" ? "s" : beat === "quiet" ? "q" : undefined}
              title={describeBeat(HOURS[index]!, beat)}
            />
          ))}
        </div>
        <div className="beat-axis">
          <span>07</span>
          <span>11</span>
          <span>15</span>
          <span>19</span>
          <span>23</span>
        </div>
        <BeatLine beats={beats} />
      </section>

      <section>
        <h2 className="section-h">
          <AlarmIcon size={14} />
          Reminders <b className="count">{reminders.length}</b>
        </h2>
        {reminders.map((reminder) => (
          <div key={reminder.key} className={reminder.fresh ? "rem is-fresh" : "rem"}>
            <time>{reminder.when}</time>
            <b>
              {reminder.title}
              {reminder.repeat === undefined ? null : (
                <span className="faint"> · {reminder.repeat}</span>
              )}
            </b>
          </div>
        ))}
      </section>

      <section>
        <h2 className="section-h">
          <MemoryIcon size={14} />
          Memory<span className="section-aside">Edit</span>
        </h2>
        <div className="core">
          <div className="core-top">
            <b>Core note</b>
            <span>1,284 of 4,000</span>
          </div>
          <div className="meter">
            <i style={{ width: "32%" }} />
          </div>
          <p>{ADA_CORE_NOTE}</p>
        </div>
        {ADA_TOPICS.map((topic) => {
          const isOpen = openTopic === topic.name;
          return (
            <button
              key={topic.name}
              type="button"
              className={isOpen ? "topic is-open" : "topic"}
              aria-expanded={isOpen}
              onClick={() => setOpenTopic(isOpen ? null : topic.name)}
            >
              <b>{topic.name}</b>
              <small>{topic.size}</small>
              <span>{isOpen ? topic.body : topic.summary}</span>
            </button>
          );
        })}
        <div className="topic topic--more faint">
          <span>+2 topics · family, reading · 7 of 24</span>
        </div>
      </section>
    </aside>
  );
}
