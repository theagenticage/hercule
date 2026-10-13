package dev.hercule.android.faces

/**
 * A colleague's state, as its face shows it, in the order of `POSES` in
 * packages/client-core/src/threads/pose.ts. [words] are the pose's words, as `POSE_WORDS` there
 * spells them: a screen writes them after the colleague's name, because the face itself is
 * hidden from accessibility services.
 *
 * Which pose a thread is in follows from its session (`decideThreadPose` in pose.ts): waiting
 * when a Request is open, away when it cannot resume or its runner is not online, asleep when it
 * exited, idle when idle, and working otherwise. A session is never failed, paused or done; only
 * subagents are.
 */
enum class Pose(val words: String) {
    Working("working"),
    Waiting("waiting on you"),
    Idle("idle"),
    Asleep("asleep"),
    Failed("failed"),
    Paused("paused"),
    Done("done"),
    Away("can't be reached"),
}
