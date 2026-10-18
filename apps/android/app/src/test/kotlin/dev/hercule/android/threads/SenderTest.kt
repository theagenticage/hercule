package dev.hercule.android.threads

import dev.hercule.android.faces.Pose
import dev.hercule.android.office.OfficeFace
import dev.hercule.android.office.buildAssistant
import dev.hercule.android.office.buildSession
import kotlin.test.assertEquals
import org.junit.Test

/**
 * Tests [describeSender], which decides the name, face and link a message shows for the agent of
 * another session that sent it. The cases are those of `describeSender` in
 * packages/client-core/src/threads/sender.test.ts, so the phone and the desktop agree, plus the
 * phone's own rule for a session it cannot open.
 */
class SenderTest {
    private val senderId = "01a06d02-beff-7037-9f5b-04287c82ebeb"
    private val ada = buildAssistant("a-ada", "Ada")
    private val adaSession = buildSession(senderId, title = "Check in.", agentId = ada.id, conversationId = ada.mainConversationId)

    @Test
    fun `shows a session of an assistant's conversation as the assistant, linking to its page`() {
        assertEquals(
            SenderReading("Ada", "Ada", OfficeFace(ada.id, Pose.Idle, isAssistant = true), SenderLink.Assistant(ada.id)),
            describeSender(senderId, adaSession, listOf(ada), opensAsThread = false),
        )
    }

    @Test
    fun `shows a listed thread by its title, linking to it`() {
        assertEquals(
            SenderReading("Fix EU checkout", "Fix EU checkout", OfficeFace(senderId, Pose.Idle, isAssistant = false), SenderLink.Thread(senderId)),
            describeSender(senderId, buildSession(senderId, title = "Fix EU checkout"), listOf(ada), opensAsThread = true),
        )
    }

    @Test
    fun `shows an assistant's session whose assistant is not listed by its title`() {
        assertEquals(
            SenderReading("Check in.", "Check in.", OfficeFace(senderId, Pose.Idle, isAssistant = false), SenderLink.None),
            describeSender(senderId, adaSession, emptyList(), opensAsThread = false),
        )
    }

    @Test
    fun `shows a session the phone does not list as a thread without a link`() {
        val stepSession = buildSession(senderId, title = "Review the diff", agentId = "ag-reviewer", runId = "run-1")
        assertEquals(SenderLink.None, describeSender(senderId, stepSession, listOf(ada), opensAsThread = false).link)
    }

    @Test
    fun `names a session with an empty title by the tail of its id`() {
        val sender = describeSender(senderId, buildSession(senderId, title = ""), emptyList(), opensAsThread = true)
        assertEquals(listOf("session 7c82ebeb", "session 7c82ebeb"), listOf(sender.label, sender.name))
    }

    @Test
    fun `shows a session that cannot be read as another agent, with no link`() {
        assertEquals(
            SenderReading("Another agent", "another agent", OfficeFace(senderId, Pose.Idle, isAssistant = false), SenderLink.None),
            describeSender(senderId, null, listOf(ada), opensAsThread = false),
        )
    }
}
