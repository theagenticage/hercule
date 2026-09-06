import { useState, type JSX } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Checkbox } from "@hydra/ui";
import { formatStamp, idTail, joinCommand, queryKeys, type HydraClient } from "@hydra/client-core";
import { joinTokensQuery } from "../../../app/queries";

/**
 * The spot a machine is enlisted from: the command that spends a token, and the
 * tokens already outstanding.
 *
 * A token is minted before the operator gets to the machine, so the ones still
 * live are listed with the invitation rather than left as something only the
 * database knows. Whether the machine is personal is answered here because it
 * is set at enlistment and nowhere else; a machine already in the fleet has the
 * tick on its own page.
 */
export function AddMachine({
  client,
  timezone,
}: {
  readonly client: HydraClient;
  readonly timezone: string;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [reserved, setReserved] = useState(false);

  const outstanding = useQuery(joinTokensQuery(client)).data ?? [];
  const reread = () => queryClient.invalidateQueries({ queryKey: queryKeys.joinTokens() });

  const mint = useMutation({
    mutationFn: () => client.runner.createJoinToken(),
    onSuccess: reread,
  });
  const revoke = useMutation({
    mutationFn: (id: string) => client.runner.revokeJoinToken({ params: { id } }),
    onSuccess: reread,
  });

  const command =
    mint.data === undefined
      ? undefined
      : joinCommand({ origin: window.location.origin, token: mint.data.token, reserved });

  return (
    <section className="flex max-w-[560px] flex-col items-start gap-1 rounded-card border border-dashed border-line px-4 py-3 text-row text-muted">
      {command === undefined ? (
        <>
          {/* Before a token exists the action is the whole of this spot, so it
              carries the name rather than repeating one above itself. */}
          <Button
            variant="primary"
            className="-ml-2"
            onClick={() => {
              mint.mutate();
            }}
            disabled={mint.isPending}
          >
            Add machine
          </Button>
          <span className="pt-0.5">
            Mint a single-use token, then run the command it gives you on that machine.
          </span>
        </>
      ) : (
        <>
          <b className="font-emph text-ink">Add machine</b>
          <span>Run this on the machine, then log in to its providers here.</span>
        </>
      )}

      {/* Above the command, because it is what the command says. */}
      <div className="pt-1.5">
        <Checkbox
          label="Personal machine - only runs work you send to it"
          checked={reserved}
          onChange={(event) => {
            setReserved(event.target.checked);
          }}
        />
      </div>

      {command === undefined ? null : (
        <>
          <code className="mt-1.5 rounded-[4px] bg-line-soft px-1.5 py-px font-mono text-fine break-all text-muted">
            {command}
          </code>
          {/* A fleet is enlisted one machine at a time and each needs a token of
              its own, so there is a way to the next one without a reload. */}
          <Button
            className="-ml-2 mt-1.5"
            onClick={() => {
              mint.mutate();
            }}
            disabled={mint.isPending}
          >
            Mint another
          </Button>
        </>
      )}

      <span className="pt-1 text-fine text-faint">
        {mint.isError
          ? "The token could not be minted. Try again."
          : revoke.isError
            ? "The token could not be revoked. Try again."
            : "A token is single-use and lasts an hour."}
      </span>

      {outstanding.length === 0 ? null : (
        <ul className="mt-2 flex w-full flex-col gap-0.5 border-t border-line-soft pt-2">
          {outstanding.map((token) => (
            <li key={token.id} className="flex items-baseline gap-2 text-fine">
              {/* Two tokens minted in the same minute read alike, so each says
                  which one it is: the tail is what the revoke names. */}
              <span className="min-w-0 flex-1 truncate text-muted">
                Token <code className="font-mono text-faint">{idTail(token.id)}</code> expires{" "}
                {formatStamp(new Date(token.expiresAt), timezone)}
              </span>
              <Button
                disabled={revoke.isPending && revoke.variables === token.id}
                onClick={() => {
                  revoke.mutate(token.id);
                }}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
