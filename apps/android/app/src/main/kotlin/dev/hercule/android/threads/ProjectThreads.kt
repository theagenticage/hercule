package dev.hercule.android.threads

import dev.hercule.android.wire.Project
import dev.hercule.android.wire.Session
import kotlin.time.Instant

/**
 * One project's section of the Threads list: its threads, newest started first.
 * [projectId] is null for the threads that belong to no project listed in the project list.
 */
data class ProjectThreads(
    val projectId: String?,
    val threads: List<Session>,
)

/**
 * Returns when a thread last started: when its session was created, or when it was last
 * reopened after being marked Done, whichever is later.
 *
 * Ported from `pickLastStartedAt` in packages/client-core/src/threads/project-rows.ts.
 */
fun pickLastStartedAt(session: Session): Instant {
    val reopenedAt = session.reopenedAt
    return if (reopenedAt != null && reopenedAt > session.createdAt) reopenedAt else session.createdAt
}

/**
 * Returns [threads] grouped by project, as the desktop sidebar groups them:
 *
 * - a thread whose project is in [projects] joins that project's group;
 * - a thread with no project, or whose project is not in [projects], joins the group of the
 *   threads with no project. That happens to a deleted project, whose threads keep its id, and
 *   briefly to a project created since the list was read. Without a name, a group would have
 *   nothing to title it;
 * - inside a group, threads are sorted newest started first by [pickLastStartedAt], ties by
 *   session id, so the order never depends on the order the server listed them in;
 * - groups are sorted by when their newest thread started, newest first, then by project id,
 *   with the threads of no project last.
 *
 * Sorting by when a thread started, not by its last activity, keeps a row in place while its
 * thread works, and puts a reopened thread at the top of its project. The caller passes only
 * the threads to list: the desktop also drops the sessions an agent runs.
 *
 * Ported from the grouping of `buildThreadGroups` in packages/client-core/src/threads/groups.ts,
 * and the sorting of `listProjectRows` and `sortProjectsByNewestThread` in
 * packages/client-core/src/threads/project-rows.ts. The desktop's workspace groups, caps and
 * draft thread are left out: the phone lists every thread of a project in one list.
 */
fun groupThreadsByProject(threads: List<Session>, projects: List<Project>): List<ProjectThreads> {
    val listedProjectIds = projects.mapTo(HashSet()) { it.id }
    return threads
        .sortedWith(compareByDescending(::pickLastStartedAt).thenBy { it.id })
        .groupBy { thread -> thread.projectId?.takeIf { it in listedProjectIds } }
        .map { (projectId, held) -> ProjectThreads(projectId, held) }
        .sortedWith(
            compareBy<ProjectThreads> { it.projectId == null }
                .thenByDescending { pickLastStartedAt(it.threads.first()) }
                .thenBy { it.projectId },
        )
}
