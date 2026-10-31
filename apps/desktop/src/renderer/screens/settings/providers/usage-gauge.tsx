import type { JSX } from "react";
import type { AccountUsageGauge } from "@hercule/client-core";
import "./providers.css";

/**
 * Renders an account's usage on its card: one thin bar for each window, with
 * its number before it and its name after it, or the credit left as a
 * number. The bar turns marigold from 80% and tomato when the limit is
 * reached. Under the lines it says when the newest reading was taken, such
 * as "as of 10:42". Each line's tooltip says what the bar means and when the
 * window resets.
 */
export function UsageGauge({ usage }: { readonly usage: AccountUsageGauge }): JSX.Element {
  return (
    <span className="pa-gauge">
      {usage.lines.map((line) =>
        line.kind === "credit" ? (
          <span key="credit" className="pa-gauge-row is-credit" title={line.text}>
            <span className="pa-gauge-num">{line.remainingText}</span>
            <span className="pa-gauge-credit">{line.suffixText}</span>
          </span>
        ) : (
          <span key={line.label} className={`pa-gauge-row is-${line.tone}`} title={line.tooltip}>
            <span className="pa-gauge-num">{line.valueText}</span>
            <span className="pa-bar" aria-hidden="true">
              <i style={{ width: `${String(line.fillPercent)}%` }} />
            </span>
            <span className="pa-gauge-label">{line.label}</span>
          </span>
        ),
      )}
      {usage.asOf !== null && <span className="pa-card-sub">{`as of ${usage.asOf}`}</span>}
    </span>
  );
}
