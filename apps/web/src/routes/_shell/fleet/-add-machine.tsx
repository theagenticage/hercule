import { useState, type JSX } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Checkbox } from "@hercule/ui";
import {
  formatStamp,
  toIdTail,
  joinCommand,
  queryKeys,
  type HerculeClient,
} from "@hercule/client-core";
import { joinTokensQuery } from "../../../app/queries";

/**
 * The card for adding a machine to the fleet: the command that uses a join
 * token, and the tokens that are still unused.
 *
 * - A token is created before the operator gets to the machine, so the unused
 *   tokens are listed here rather than known only to the database.
 * - The "personal machine" checkbox is here because the join command sets it.
 *   A machine already in the fleet has the same checkbox on its own page.
 */
export function AddMachine({
  client,
  timezone,
}: {
  readonly client: HerculeClient;
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

  const note = mint.isError
    ? "The token could not be minted. Try again."
    : revoke.isError
      ? "The token could not be revoked. Try again."
      : "A token is single-use and lasts an hour.";

  return (
    <section className="flex max-w-[560px] flex-col items-start gap-1 rounded-card border border-dashed border-line px-4 py-3 text-row text-muted">
      {command === undefined ? (
        <>
          {/* Before a token exists, the button is the card's only action, so it
              doubles as the card's title. */}
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

      {/* Above the command, because the checkbox changes the command. */}
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
          {/* Each machine needs its own token, so the user can create the next
              one without a reload. */}
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

      <span className="pt-1 text-fine text-faint">{note}</span>

      {outstanding.length === 0 ? null : (
        <ul className="mt-2 flex w-full flex-col gap-0.5 border-t border-line-soft pt-2">
          {outstanding.map((token) => (
            <li key={token.id} className="flex items-baseline gap-2 text-fine">
              {/* Two tokens created in the same minute look alike, so each shows
                  the tail of its id to tell them apart. */}
              <span className="min-w-0 flex-1 truncate text-muted">
                Token <code className="font-mono text-faint">{toIdTail(token.id)}</code> expires{" "}
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
