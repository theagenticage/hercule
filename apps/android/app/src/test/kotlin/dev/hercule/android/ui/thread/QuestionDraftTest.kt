package dev.hercule.android.ui.thread

import dev.hercule.android.wire.Question
import dev.hercule.android.wire.QuestionOption
import kotlin.test.assertEquals
import kotlin.test.assertNull
import org.junit.Test

/**
 * Tests the question draft. The cases are ported from
 * packages/client-core/src/threads/question-draft.test.ts, except `isQuestionAnswered`, which the
 * app does not port. The app sends every answer as a list, so a single-select answer is a
 * one-item list here.
 */
class QuestionDraftTest {
    private val storage = Question(
        question = "Which storage should drafts use?",
        header = "Storage",
        options = listOf(
            QuestionOption("localStorage", "small and synchronous"),
            QuestionOption("IndexedDB", "large and asynchronous"),
        ),
        multiSelect = false,
    )
    private val features = Question(
        question = "Which features should ship?",
        header = "Features",
        options = listOf(QuestionOption("Sync", ""), QuestionOption("Search", ""), QuestionOption("Export", "")),
        multiSelect = true,
    )
    private val questions = listOf(storage, features)

    @Test
    fun `starts with no answers`() {
        assertNull(buildQuestionAnswers(buildQuestionDraft(questions), questions))
    }

    @Test
    fun `selects only the picked option on a single-select question, and clears the typed text`() {
        var draft = buildQuestionDraft(questions)
        draft = typeQuestionAnswer(draft, storage, "a sqlite file")
        draft = pickQuestionOption(draft, storage, "localStorage")
        draft = pickQuestionOption(draft, storage, "IndexedDB")

        assertEquals(QuestionDraftAnswer(listOf("IndexedDB"), ""), draft[storage.header])
    }

    @Test
    fun `clears the pick when the user types on a single-select question`() {
        var draft = buildQuestionDraft(questions)
        draft = pickQuestionOption(draft, storage, "localStorage")
        draft = typeQuestionAnswer(draft, storage, "a sqlite file")

        assertEquals(QuestionDraftAnswer(emptyList(), "a sqlite file"), draft[storage.header])
    }

    @Test
    fun `toggles a picked option on a multiSelect question, and keeps the typed text`() {
        var draft = buildQuestionDraft(questions)
        draft = typeQuestionAnswer(draft, features, "Offline mode")
        draft = pickQuestionOption(draft, features, "Sync")
        draft = pickQuestionOption(draft, features, "Search")
        draft = pickQuestionOption(draft, features, "Sync")

        assertEquals(QuestionDraftAnswer(listOf("Search"), "Offline mode"), draft[features.header])
    }

    @Test
    fun `builds no answers while one question is unanswered`() {
        val draft = pickQuestionOption(buildQuestionDraft(questions), storage, "localStorage")

        assertNull(buildQuestionAnswers(draft, questions))
    }

    @Test
    fun `builds no answers while a question has only blank text or a pick toggled off`() {
        var draft = buildQuestionDraft(questions)
        draft = typeQuestionAnswer(draft, storage, "  \n ")
        draft = pickQuestionOption(pickQuestionOption(draft, features, "Sync"), features, "Sync")

        assertNull(buildQuestionAnswers(draft, questions))
    }

    @Test
    fun `builds the picks in option order, then the trimmed text`() {
        var draft = buildQuestionDraft(questions)
        draft = pickQuestionOption(draft, storage, "localStorage")
        // Picked out of option order, so the list's order cannot come from the taps.
        draft = pickQuestionOption(draft, features, "Export")
        draft = pickQuestionOption(draft, features, "Sync")
        draft = typeQuestionAnswer(draft, features, "  Offline mode  ")

        assertEquals(
            mapOf("Storage" to listOf("localStorage"), "Features" to listOf("Sync", "Export", "Offline mode")),
            buildQuestionAnswers(draft, questions),
        )
    }

    @Test
    fun `answers a single-select question with its trimmed text, and leaves blank text out of a multiSelect list`() {
        var draft = buildQuestionDraft(questions)
        draft = typeQuestionAnswer(draft, storage, "  a sqlite file \n")
        draft = pickQuestionOption(draft, features, "Search")
        draft = typeQuestionAnswer(draft, features, "   ")

        assertEquals(
            mapOf("Storage" to listOf("a sqlite file"), "Features" to listOf("Search")),
            buildQuestionAnswers(draft, questions),
        )
    }

    @Test
    fun `answers a multiSelect question with only typed text as a one-item list`() {
        var draft = buildQuestionDraft(questions)
        draft = pickQuestionOption(draft, storage, "IndexedDB")
        draft = typeQuestionAnswer(draft, features, " Offline mode ")

        assertEquals(
            mapOf("Storage" to listOf("IndexedDB"), "Features" to listOf("Offline mode")),
            buildQuestionAnswers(draft, questions),
        )
    }
}
