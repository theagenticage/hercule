package dev.hercule.android.ui.thread

import dev.hercule.android.wire.Question
import dev.hercule.android.wire.QuestionAnswers

/** What the user has given so far for one question: the picked option labels, and the typed text. */
data class QuestionDraftAnswer(val picks: List<String>, val text: String)

/**
 * The answers of a question Request before they are sent, keyed by each question's header.
 *
 * A port of packages/client-core/src/threads/question-draft.ts, so the phone and the desktop
 * agree on what counts as an answer. Every function returns a new draft.
 */
typealias QuestionDraft = Map<String, QuestionDraftAnswer>

/** Builds the draft of [questions] with nothing picked and nothing typed. */
fun buildQuestionDraft(questions: List<Question>): QuestionDraft =
    questions.associate { it.header to QuestionDraftAnswer(emptyList(), "") }

/**
 * Returns [draft] with the option [label] picked for [question].
 *
 * - On a single-select question the pick replaces any earlier pick and clears the typed text,
 *   because the question takes one answer.
 * - On a multiSelect question the pick toggles and the typed text stays. The picks are kept in
 *   option order, so the answers do not depend on the order of taps.
 */
fun pickQuestionOption(draft: QuestionDraft, question: Question, label: String): QuestionDraft {
    if (!question.multiSelect) return draft + (question.header to QuestionDraftAnswer(listOf(label), ""))
    val current = draft.getValue(question.header)
    val picked = label in current.picks
    val picks = question.options.map { it.label }
        .filter { if (it == label) !picked else it in current.picks }
    return draft + (question.header to current.copy(picks = picks))
}

/**
 * Returns [draft] with [text] as the user's own answer to [question]. On a single-select
 * question the text replaces the pick, because the question takes one answer.
 */
fun typeQuestionAnswer(draft: QuestionDraft, question: Question, text: String): QuestionDraft {
    val picks = if (question.multiSelect) draft.getValue(question.header).picks else emptyList()
    return draft + (question.header to QuestionDraftAnswer(picks, text))
}

/**
 * Builds the answers to send from [draft], or returns null while any of [questions] has neither
 * a pick nor typed text that is not blank, because the controller refuses answers that leave a
 * question out.
 *
 * A single-select question is answered with its pick or its trimmed text. A multiSelect question
 * is answered with its picks in option order, then its trimmed text when that is not blank.
 */
fun buildQuestionAnswers(draft: QuestionDraft, questions: List<Question>): QuestionAnswers? {
    val answers = questions.associate { question ->
        val answer = draft.getValue(question.header)
        val typed = answer.text.trim()
        val given = if (typed.isEmpty()) answer.picks else answer.picks + typed
        question.header to if (question.multiSelect) given else given.take(1)
    }
    return answers.takeIf { it.values.all { given -> given.isNotEmpty() } }
}
