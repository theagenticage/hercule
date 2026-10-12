/**
 * The foot under Intake's To do list: how many signals were cleared today
 * (spec 17 §The foot, the toast and failures).
 */
import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import { countClearedToday, describeIntakeFoot } from "@hercule/client-core";
import { useSignalsClearedToday } from "./use-signals-cleared-today";

/**
 * Renders the foot: "7 cleared today. See Done.", counted in `timezone`,
 * the user's timezone setting. "See Done" links to the Done view. With
 * nothing cleared today there is no foot.
 */
export function IntakeFoot({ timezone }: { readonly timezone: string }): JSX.Element | null {
  const { signals, now } = useSignalsClearedToday(timezone);
  const line = describeIntakeFoot(countClearedToday(signals, now, timezone));
  if (line === null) return null;
  return (
    <p className="asks-cleared">
      {line}{" "}
      <Link to="/intake" search={{ view: "done" }} className="asks-cleared-link">
        See Done
      </Link>
      .
    </p>
  );
}
