/**
 * Builds the command the Fleet screen shows for adding a machine as a runner.
 *
 * The controller address in the command is the one this browser is talking to,
 * not the address the controller reports for itself. An address that works
 * from this browser is most likely one the operator can paste and use.
 *
 * `--reserved` adds a runner that only runs work sent to it by name.
 */
export const joinCommand = ({
  origin,
  token,
  reserved,
}: {
  readonly origin: string;
  readonly token: string;
  readonly reserved: boolean;
}): string => `hercule runner join ${origin} --token ${token}${reserved ? " --reserved" : ""}`;
