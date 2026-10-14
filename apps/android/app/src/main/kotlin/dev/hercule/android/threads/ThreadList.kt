package dev.hercule.android.threads

import dev.hercule.android.faces.Pose
import dev.hercule.android.office.OfficeFace
import dev.hercule.android.office.decideThreadPose
import dev.hercule.android.office.formatAge
import dev.hercule.android.office.formatRequestQuestion
import dev.hercule.android.office.listWaiting
import dev.hercule.android.wire.Project
import dev.hercule.android.wire.Runner
import dev.hercule.android.wire.Session
import kotlin.time.Instant

/**
 * Everything the Threads screen draws (the book's mobile/threads.html), from top to bottom:
 *
 * - [waiting]: Waiting on you, every thread with an open Request, the most recently active
 *   first. A waiting thread is also listed in its project, or on the Done shelf;
 * - [projects]: one section per project, for the threads not marked Done;
 * - the Done shelf: [doneCount] threads are marked Done, [doneRows] are the ones it shows, and
 *   [hiddenDoneCount] are left behind its "Show 25 more" row.
 */
data class ThreadList(
    val waiting: List<ThreadRow>,
    val projects: List<ProjectSection>,
    val doneCount: Int,
    val doneRows: List<ThreadRow>,
    val hiddenDoneCount: Int,
) {
    /** Checks whether the list holds no thread at all, which the screen draws as its empty state. */
    fun isEmpty(): Boolean = waiting.isEmpty() && projects.isEmpty() && doneCount == 0
}

/**
 * One project's section: its [project], or null for the threads in no project, its rows, and
 * [waitingCount], how many of them wait on the user.
 */
data class ProjectSection(val project: Project?, val rows: List<ThreadRow>, val waitingCount: Int)

/**
 * One row of the Threads list.
 *
 * - [status] is what the row's right end shows. A row in Waiting on you and a row on the Done
 *   shelf always show [age]; a row in a project shows what [decideThreadRowStatus] decides.
 * - [age] is the time since the thread was last active, or, on the Done shelf, since it was
 *   marked Done, as [formatAge] writes it.
 * - [detail] is the question of the oldest open Request when the thread waits, as
 *   [formatRequestQuestion] writes it, and the pose's words otherwise.
 * - [project] is the thread's project, or null when it has none or the project list does not
 *   hold it.
 */
data class ThreadRow(
    val sessionId: String,
    val title: String,
    val face: OfficeFace,
    val status: ThreadRowStatus,
    val age: String,
    val detail: String,
    val project: Project?,
)

/**
 * Builds the Threads list from what the app has read, as the desktop sidebar lists threads:
 *
 * - [sessions]: the threads. Run sessions and an agent's sessions are left out, as the desktop
 *   leaves them out;
 * - [runners]: every runner, for each thread's pose. A runner missing from the list counts as
 *   connected;
 * - [projects]: the projects, for each section's name;
 * - [now]: the moment every age is measured from;
 * - [doneLimit]: how many Done threads the shelf shows, or null while it is closed.
 *
 * Waiting on you is sorted as [listWaiting] sorts it, so it agrees with the alerts. A waiting
 * thread marked Done stays in Waiting on you, because it still waits on the user, and moves from
 * its project to the Done shelf. Projects are grouped and sorted by [groupThreadsByProject], the
 * shelf by [buildDoneShelf].
 */
fun buildThreadList(
    sessions: List<Session>,
    runners: List<Runner>,
    projects: List<Project>,
    now: Instant,
    doneLimit: Int?,
): ThreadList {
    val threads = sessions.filter { it.runId == null && it.agentId == null }
    val threadsById = threads.associateBy { it.id }
    val runnersById = runners.associateBy { it.id }
    val projectsById = projects.associateBy { it.id }

    fun buildRow(thread: Session, status: ThreadRowStatus, since: Instant): ThreadRow {
        val pose = decideThreadPose(thread, runnersById[thread.runnerId])
        val request = thread.openRequests.firstOrNull()
        return ThreadRow(
            sessionId = thread.id,
            title = thread.title,
            face = OfficeFace(seed = thread.id, pose = pose, isAssistant = false),
            status = status,
            age = formatAge(since, now),
            detail = if (request != null) formatRequestQuestion(request) else pose.words,
            project = projectsById[thread.projectId],
        )
    }

    val waiting = listWaiting(threads, emptyList(), emptyMap()).map { entry ->
        buildRow(threadsById.getValue(entry.sessionId), ThreadRowStatus.Age, entry.activityAt)
    }
    val sections = groupThreadsByProject(threads.filterNot(::isMarkedDone), projects).map { group ->
        val rows = group.threads.map { buildRow(it, decideThreadRowStatus(it, runnersById[it.runnerId]), it.lastActivityAt) }
        ProjectSection(projectsById[group.projectId], rows, rows.count { it.face.pose == Pose.Waiting })
    }
    val shelf = buildDoneShelf(threads, doneLimit)
    return ThreadList(
        waiting = waiting,
        projects = sections,
        doneCount = shelf.count,
        doneRows = shelf.threads.map { buildRow(it, ThreadRowStatus.Age, checkNotNull(it.done).at) },
        hiddenDoneCount = shelf.hiddenCount,
    )
}
