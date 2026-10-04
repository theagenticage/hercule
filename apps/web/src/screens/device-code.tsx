import type { JSX } from "react";
import { Button } from "@hercule/ui";

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
          // `clipboard` is undefined over plain HTTP except on localhost. The
          // code is on screen anyway.
          void navigator.clipboard?.writeText(code);
        }}
      >
        Copy code
      </Button>
    </div>
  );
}
