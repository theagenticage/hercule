import type { JSX } from "react";
import { Button } from "@hercule/ui";
import { copyText } from "./clipboard";

/**
 * A one-time code the user types in at a provider, shown large enough to read
 * across a desk, with a button that copies it. A provider login and a
 * connection's device flow both show their code this way.
 */
export function DeviceCode({ code }: { readonly code: string }): JSX.Element {
  return (
    <div className="flex flex-col items-start gap-1.5">
      <p className="font-mono text-title tracking-widest text-ink">{code}</p>
      <Button
        className="-ml-2"
        onClick={() => {
          // A refused copy is not reported: the code is on screen anyway.
          void copyText(code);
        }}
      >
        Copy code
      </Button>
    </div>
  );
}
