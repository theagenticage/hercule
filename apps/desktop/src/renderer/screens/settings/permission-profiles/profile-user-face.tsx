import type { JSX } from "react";
import type { Pose, ProfileUser } from "@hercule/client-core";
import { buildLook, Face } from "../../../faces";

/** An agent or assistant that carries a permission profile, with the pose its face shows. */
export interface PosedProfileUser extends ProfileUser {
  readonly pose: Pose;
}

/** Renders the face of `user`, `size` CSS pixels square, in the look its id gives. */
export function ProfileUserFace({
  user,
  size,
}: {
  readonly user: PosedProfileUser;
  readonly size: number;
}): JSX.Element {
  return <Face look={buildLook(user.id)} pose={user.pose} size={size} />;
}
