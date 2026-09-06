/**
 * The command that enlists a machine, as the Fleet screen hands it over.
 *
 * The controller address in it is the one this browser is talking to rather
 * than anything the controller reports about itself: an address that works from
 * here is the one the operator can paste, whatever the controller calls itself.
 */

/** `--reserved` enlists a machine that runs only work sent to it by name. */
export const joinCommand = ({
  origin,
  token,
  reserved,
}: {
  readonly origin: string;
  readonly token: string;
  readonly reserved: boolean;
}): string => `hydra runner join ${origin} --token ${token}${reserved ? " --reserved" : ""}`;
