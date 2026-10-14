package dev.hercule.android.threads

import dev.hercule.android.wire.Session
import dev.hercule.android.wire.SessionStatus

/**
 * Checks whether the user marked the thread Done. A Done thread leaves its project's list for
 * the Done shelf until it is reopened. Done is the user's word about the thread, apart from its
 * session's status: a Done thread may still be running, and an exited one need not be Done.
 *
 * Ported from `isMarkedDone` in packages/client-core/src/threads/status.ts.
 */
fun isMarkedDone(session: Session): Boolean = session.done != null

/**
 * Returns why a thread cannot take input, as a phrase the composer can show after "This thread
 * can't be resumed: ", or null when the thread can take input. Only an exited session that
 * cannot be resumed is blocked, for one of two reasons:
 *
 * - it has no native session id, so its transcript is gone;
 * - otherwise, the runner it ran on was retired.
 *
 * Ported from `findResumeBlockedReason` in packages/client-core/src/threads/resume-blocked.ts.
 */
fun findResumeBlockedReason(session: Session): String? {
    if (session.status != SessionStatus.Exited || session.resumable) return null
    return if (session.nativeSessionId == null) "its transcript is gone" else "its runner was retired"
}
