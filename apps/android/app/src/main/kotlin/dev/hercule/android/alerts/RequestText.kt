package dev.hercule.android.alerts

import dev.hercule.android.wire.CommandApproval
import dev.hercule.android.wire.FileChangeApproval
import dev.hercule.android.wire.FileReadApproval
import dev.hercule.android.wire.QuestionRequest
import dev.hercule.android.wire.SessionRequest
import dev.hercule.android.wire.ToolApproval
import dev.hercule.android.wire.UnknownRequest

/**
 * Returns the one-line question for an open Request, ported from client-core's
 * `formatRequestQuestion` (`packages/client-core/src/threads/request-question.ts`):
 *
 * - a command: "Run <the command's first non-empty line>?", or "Run this command?" when the
 *   harness sent no command;
 * - a file change or read: the file's name, or how many files;
 * - a tool call: "Run <tool name>?";
 * - a question: the first question, in the agent's own words.
 *
 * A Request of a kind this build does not know has no question to show, so it reads
 * "Waiting on you".
 */
fun formatRequestQuestion(request: SessionRequest): String = when (request) {
    is CommandApproval ->
        request.detail.command.lineSequence().map { it.trim() }.firstOrNull { it.isNotEmpty() }
            ?.let { "Run $it?" } ?: "Run this command?"
    is FileChangeApproval -> describeFiles("Change", request.detail.paths)
    is FileReadApproval -> describeFiles("Read", request.detail.paths)
    is ToolApproval -> "Run ${request.detail.toolName}?"
    is QuestionRequest -> request.detail.questions.firstOrNull()?.question.orEmpty()
    is UnknownRequest -> "Waiting on you"
}

/**
 * Returns the text of a Request alert, ported from client-core's `formatNotificationBody`
 * (`packages/client-core/src/waiting.ts`): the question of [newest], prefixed with
 * "<subagent> asks: " when a subagent asked, and followed by "+N more waiting" on a second
 * line when [others] other Requests are open on the same destination.
 */
fun formatAlertBody(newest: SessionRequest, others: Int): String {
    val asker = if (newest.subagentId == null) "" else "${newest.subagentName ?: "A subagent"} asks: "
    val more = if (others == 0) "" else "\n+$others more waiting"
    return asker + formatRequestQuestion(newest) + more
}

/**
 * Returns the last part of a path: a file's name, or a directory's name when the path ends
 * in "/". Returns the whole path when it has no last part, as "/" has none.
 */
internal fun readFileName(path: String): String {
    val name = path.trimEnd('/').substringAfterLast('/')
    return name.ifEmpty { path }
}

/** Returns what a file Request asks for, such as "Change checkout.ts?" or "Read 3 files?". */
private fun describeFiles(verb: String, paths: List<String>): String = when (paths.size) {
    0 -> "$verb files?"
    1 -> "$verb ${readFileName(paths.single())}?"
    else -> "$verb ${paths.size} files?"
}
