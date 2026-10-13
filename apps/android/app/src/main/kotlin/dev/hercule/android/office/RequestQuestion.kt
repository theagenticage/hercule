package dev.hercule.android.office

import dev.hercule.android.wire.CommandApproval
import dev.hercule.android.wire.FileChangeApproval
import dev.hercule.android.wire.FileReadApproval
import dev.hercule.android.wire.QuestionRequest
import dev.hercule.android.wire.SessionRequest
import dev.hercule.android.wire.ToolApproval
import dev.hercule.android.wire.UnknownRequest

/**
 * Returns the one-line question for an open Request, as a Waiting on you row shows it under
 * the title:
 *
 * - a command: "Run <the command's first non-empty line>?", or "Run this command?" when the
 *   harness sent no command;
 * - a file change or read: the file's name, or how many files;
 * - a tool call: "Run <tool name>?";
 * - a question: the first question, in the agent's own words;
 * - a kind this build does not know: "Answer this request?". The desktop has no such case,
 *   because its contract rejects unknown kinds; the app decodes them so it can still show them.
 *
 * The line may be long; the row shortens it with an ellipsis.
 *
 * Ported from `formatRequestQuestion` in packages/client-core/src/threads/request-question.ts.
 */
fun formatRequestQuestion(request: SessionRequest): String = when (request) {
    is CommandApproval -> {
        val line = request.detail.command.split("\n").map { it.trim() }.firstOrNull { it.isNotEmpty() }
        if (line == null) "Run this command?" else "Run $line?"
    }
    is FileChangeApproval -> describeFiles("Change", request.detail.paths)
    is FileReadApproval -> describeFiles("Read", request.detail.paths)
    is ToolApproval -> "Run ${request.detail.toolName}?"
    is QuestionRequest -> request.detail.questions.first().question
    is UnknownRequest -> "Answer this request?"
}

/**
 * Returns what a file Request asks for, such as "Change checkout.ts?" or "Read 3 files?". A
 * Request with no path asks about "files", because some harnesses do not say which files a
 * change touches.
 */
private fun describeFiles(verb: String, paths: List<String>): String = when (paths.size) {
    0 -> "$verb files?"
    1 -> "$verb ${readFileName(paths.single())}?"
    else -> "$verb ${paths.size} files?"
}

/**
 * Returns the last part of a path: a file's name, or a directory's name when the path ends in
 * "/", such as "src" for "/Users/x/src/". Returns the whole path when it has no last part, as
 * "/" has none. The Live Update names a step's file with it too.
 */
internal fun readFileName(path: String): String {
    val name = path.trimEnd('/').substringAfterLast('/')
    return name.ifEmpty { path }
}
