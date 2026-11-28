import type { JSX } from "react";
import type { AccountUsageGauge } from "@hercule/client-core";
import "./providers.css";

/**
 * Renders the account's usage in the sheet, as the card shows it with more
 * room: one row for each window with its name, a bar, its number and when it
 * resets, or the credit left, and under the rows when the newest reading was
 * taken, such as "as of 10:42". The bar turns marigold from 80% and tomato
 * when the limit is reached.
 */
export function SheetUsage({ usage }: { readonly usage: AccountUsageGauge }): JSX.Element {
  return (
    <div className="pa-use">
      {usage.lines.map((line) =>
        line.kind === "credit" ? (
          <div key="credit" className="pa-use-row is-credit">
            <span>{line.label}</span>
            <span className="pa-use-credit">
              {line.remainingText}
              <small>{` ${line.suffixText}`}</small>
            </span>
          </div>
        ) : (
          <div key={line.label} className={`pa-use-row is-${line.tone}`}>
            <span>{line.label}</span>
            <span className="pa-use-bar" aria-hidden="true">
              <i style={{ width: `${String(line.fillPercent)}%` }} />
            </span>
            <b>{line.valueText}</b>
            <small>{line.resetsText}</small>
          </div>
        ),
      )}
      {usage.asOf !== null && <p className="pa-hint">{`as of ${usage.asOf}`}</p>}
    </div>
  );
}
