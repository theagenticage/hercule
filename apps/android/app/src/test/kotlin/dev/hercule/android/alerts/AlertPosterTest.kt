package dev.hercule.android.alerts

import android.Manifest
import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import android.content.pm.ShortcutManager
import android.graphics.Bitmap
import androidx.core.app.NotificationCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadows.ShadowShortcutManager

/** Checks on Robolectric that the poster builds conversation notifications Android accepts. */
@RunWith(AndroidJUnit4::class)
class AlertPosterTest {
    private val context: Application = ApplicationProvider.getApplicationContext()
    private val manager = context.getSystemService(NotificationManager::class.java)

    /** Draws plain squares: the poster only passes the faces on. */
    private val faces = object : AlertFaces {
        private val square = IconCompat.createWithBitmap(Bitmap.createBitmap(8, 8, Bitmap.Config.ARGB_8888))
        override fun drawPersonIcon(seedId: String, isAssistant: Boolean, pose: AlertFacePose) = square
        override fun drawTrackerIcon(sessionId: String, pose: AlertFacePose) = square
        override fun readHueColor(sessionId: String) = 0xFF3366CC.toInt()
    }
    private val poster = AlertPoster(context, faces)

    @Before
    fun grantNotifications() {
        shadowOf(context).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        createAlertChannels(context)
        ShadowRecordingShortcutManager.removedLongLivedIds.clear()
    }

    private fun post(alert: AssistantAlert) = poster.apply(AlertDecision(AlertMemory(), listOf(AlertChange.Post(alert, withSound = true)), emptyList()))

    private fun showLiveUpdates(vararg updates: LiveUpdate) = poster.apply(AlertDecision(AlertMemory(), emptyList(), updates.toList()))

    private fun buildWaitingUpdate(sessionId: String = "s1", requestId: String = "r1") =
        buildLiveUpdate(buildSession(sessionId, openRequests = listOf(buildCommand(requestId))), emptyList(), alert = true)

    private val requestAlert = AssistantAlert(
        "assistant-1",
        "Poirot",
        listOf(AlertMessage("Run pnpm test cart?", fromOwner = false, AT)),
        "r1",
        decideAlertActions("s9", buildCommand("r1")),
    )

    @Test
    fun `creates the four channels with their importance`() {
        assertEquals(NotificationManager.IMPORTANCE_HIGH, manager.getNotificationChannel(AlertChannels.WAITING).importance)
        assertEquals(NotificationManager.IMPORTANCE_HIGH, manager.getNotificationChannel(AlertChannels.MESSAGES).importance)
        assertEquals(NotificationManager.IMPORTANCE_DEFAULT, manager.getNotificationChannel(AlertChannels.WORKING).importance)
        val connection = manager.getNotificationChannel(AlertChannels.CONNECTION)
        assertEquals(NotificationManager.IMPORTANCE_MIN, connection.importance)
        assertEquals(null, connection.sound)
    }

    @Test
    fun `posts a waiting thread's Live Update on the Request channel with its two buttons`() {
        val update = buildWaitingUpdate()
        showLiveUpdates(update)

        val posted = manager.activeNotifications.single()
        assertEquals("thread:s1", posted.tag)
        assertEquals(LIVE_UPDATE_ID, posted.id)
        assertEquals(AlertChannels.WAITING, posted.notification.channelId)
        assertTrue(posted.isOngoing)
        assertEquals(update.text, posted.notification.extras.getCharSequence(NotificationCompat.EXTRA_TEXT).toString())
        assertEquals(listOf("Allow", "Deny"), posted.notification.actions.map { it.title })
    }

    @Test
    fun `posts a Live Update per thread, and ends the one that leaves the decision`() {
        showLiveUpdates(buildWaitingUpdate("s1"), buildLiveUpdate(buildSession("s2"), emptyList(), alert = false))
        assertEquals(setOf("thread:s1", "thread:s2"), manager.activeNotifications.map { it.tag }.toSet())

        showLiveUpdates(buildWaitingUpdate("s1"))
        assertEquals("thread:s1", manager.activeNotifications.single().tag)
    }

    @Test
    fun `a new poster ends the Live Updates an earlier process left behind`() {
        showLiveUpdates(buildWaitingUpdate("s1"))

        AlertPoster(context, faces).apply(AlertDecision(AlertMemory(), emptyList(), emptyList()))

        assertTrue(manager.activeNotifications.isEmpty())
    }

    @Test
    fun `posts an assistant alert with a Reply that takes text`() {
        post(AssistantAlert("assistant-1", "Poirot", listOf(AlertMessage("Done.", fromOwner = false, AT)), null, AlertActions.Reply("c1", 7L)))

        val posted = manager.activeNotifications.single()
        assertEquals(AlertChannels.MESSAGES, posted.notification.channelId)
        assertEquals("assistant:assistant-1", posted.notification.shortcutId)
        val reply = posted.notification.actions.single()
        assertEquals("Reply", reply.title)
        assertEquals(AlertIntents.KEY_REPLY_TEXT, reply.remoteInputs.single().resultKey)
        assertEquals(
            AlertAction.SendReply(AssistantAlertKey("assistant-1"), ASSISTANT_ALERT_ID, "Poirot", "Reply", "c1", 7L),
            AlertIntents.readAction(shadowOf(reply.actionIntent).savedIntent),
        )
    }

    @Test
    fun `posts an assistant's Request as a conversation on the Request channel`() {
        post(requestAlert)

        val posted = manager.activeNotifications.single()
        assertEquals(AlertChannels.WAITING, posted.notification.channelId)
        val style = assertNotNull(NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(posted.notification))
        assertEquals("Run pnpm test cart?", style.messages.single().text)
        assertEquals(listOf("Allow", "Deny"), posted.notification.actions.map { it.title })
    }

    @Test
    @Config(shadows = [ShadowRecordingShortcutManager::class])
    fun `removing an assistant alert keeps the assistant's sharing shortcut`() {
        post(AssistantAlert("assistant-1", "Poirot", listOf(AlertMessage("Done.", fromOwner = false, AT)), null, AlertActions.Reply("c1", 7L)))
        poster.apply(AlertDecision(AlertMemory(), listOf(AlertChange.Remove(AssistantAlertKey("assistant-1"))), emptyList()))

        assertTrue(manager.activeNotifications.isEmpty())
        assertEquals(emptyList(), ShadowRecordingShortcutManager.removedLongLivedIds)
    }

    @Test
    fun `a refresh replaces an alert on screen, and leaves a swiped-away alert away`() {
        val newer = requestAlert.copy(messages = listOf(AlertMessage("Run git push?", fromOwner = false, AT)))
        val refresh = AlertDecision(AlertMemory(), listOf(AlertChange.Refresh(newer)), emptyList())
        post(requestAlert)

        poster.apply(refresh)
        val text = manager.activeNotifications.single().notification.extras.getCharSequence(NotificationCompat.EXTRA_TEXT)
        assertEquals("Run git push?", text.toString())

        // The user swipes the alert away.
        manager.cancel("assistant:assistant-1", ASSISTANT_ALERT_ID)
        poster.apply(refresh)
        assertTrue(manager.activeNotifications.isEmpty())
    }

    @Test
    fun `clears every alert, Live Update and shortcut at sign-out`() {
        post(requestAlert)
        showLiveUpdates(buildWaitingUpdate())
        poster.clearAll()

        assertTrue(manager.activeNotifications.isEmpty())
        assertTrue(ShortcutManagerCompat.getDynamicShortcuts(context).isEmpty())
    }

    @Test
    fun `replaces an alert with what failed when a button's call fails`() {
        post(requestAlert)
        val action = AlertAction.Decide(AssistantAlertKey("assistant-1"), ASSISTANT_ALERT_ID, "Poirot", "Allow", "s9", "r1", buildCommand("r1").decisions.first())
        finishAlertAction(context, action, AlertActionOutcome.Failed("the controller did not answer in time"))

        val posted = manager.activeNotifications.single()
        assertEquals(
            "Allow failed: the controller did not answer in time",
            posted.notification.extras.getCharSequence(NotificationCompat.EXTRA_TEXT).toString(),
        )
    }

    @Test
    fun `a button's outcome leaves alone an alert that shows a newer Request by now`() {
        post(requestAlert.copy(requestId = "r2"))
        val tappedOnR1 = AlertAction.Decide(AssistantAlertKey("assistant-1"), ASSISTANT_ALERT_ID, "Poirot", "Allow", "s9", "r1", buildCommand("r1").decisions.first())

        for (outcome in listOf(AlertActionOutcome.Done, AlertActionOutcome.AlreadyAnswered, AlertActionOutcome.Failed("timeout"))) {
            finishAlertAction(context, tappedOnR1, outcome)

            val posted = manager.activeNotifications.single()
            assertEquals("Run pnpm test cart?", posted.notification.extras.getCharSequence(NotificationCompat.EXTRA_TEXT).toString())
        }
    }

    @Test
    fun `a newer Request on the same thread leaves the older Live Update's buttons answering the older Request`() {
        showLiveUpdates(buildWaitingUpdate(requestId = "r1"))
        val allowOnR1 = manager.activeNotifications.single().notification.actions.first { it.title == "Allow" }.actionIntent

        // A tap can land after the newer Request was posted but before the shade redraws.
        showLiveUpdates(buildWaitingUpdate(requestId = "r2"))

        val tapped = assertIs<AlertAction.Decide>(AlertIntents.readAction(shadowOf(allowOnR1).savedIntent))
        assertEquals("r1", tapped.requestId)
    }

    @Test
    fun `a sent reply leaves alone an assistant alert that shows a Request by now`() {
        post(requestAlert)
        val reply = AlertAction.SendReply(AssistantAlertKey("assistant-1"), ASSISTANT_ALERT_ID, "Poirot", "Reply", "c1", 7L)

        finishAlertAction(context, reply, AlertActionOutcome.Done)

        assertEquals("assistant:assistant-1", manager.activeNotifications.single().tag)
    }

    @Test
    fun `a reply's outcome leaves alone a newer message alert, and removes the one replied in`() {
        val replyIn = AlertAction.SendReply(AssistantAlertKey("assistant-1"), ASSISTANT_ALERT_ID, "Poirot", "Reply", "c1", 7L)
        // A newer message from the assistant arrives while the reply is being sent.
        post(AssistantAlert("assistant-1", "Poirot", listOf(AlertMessage("One more thing.", fromOwner = false, AT)), null, AlertActions.Reply("c1", 8L)))

        finishAlertAction(context, replyIn, AlertActionOutcome.Done)
        finishAlertAction(context, replyIn, AlertActionOutcome.Failed("the controller did not answer in time"))

        val shown = manager.activeNotifications.single().notification
        assertEquals("One more thing.", shown.extras.getCharSequence(NotificationCompat.EXTRA_TEXT).toString())

        finishAlertAction(context, replyIn.copy(newestMessagePosition = 8L), AlertActionOutcome.Done)
        assertTrue(manager.activeNotifications.isEmpty())
    }

    @Test
    fun `a failed Live Update button says so in the Live Update itself`() {
        showLiveUpdates(buildWaitingUpdate())
        val action = AlertAction.Decide(ThreadAlertKey("s1"), LIVE_UPDATE_ID, "Fix 3-D Secure checkout", "Allow", "s1", "r1", buildCommand("r1").decisions.first())

        finishAlertAction(context, action, AlertActionOutcome.Failed("the controller did not answer in time"))

        val posted = manager.activeNotifications.single()
        assertEquals(LIVE_UPDATE_ID, posted.id)
        assertTrue(posted.isOngoing)
        assertEquals(
            "Allow failed: the controller did not answer in time",
            posted.notification.extras.getCharSequence(NotificationCompat.EXTRA_TEXT).toString(),
        )
        assertEquals(listOf("Allow", "Deny"), posted.notification.actions.map { it.title })
        assertEquals(
            Notification.ProgressStyle::class.java.name,
            posted.notification.extras.getString(Notification.EXTRA_TEMPLATE),
        )

        // The rebuilt Live Update still shows r1, so a second tap's failure replaces the first.
        finishAlertAction(context, action, AlertActionOutcome.Failed("the runner is offline"))
        assertEquals(
            "Allow failed: the runner is offline",
            manager.activeNotifications.single().notification.extras.getCharSequence(NotificationCompat.EXTRA_TEXT).toString(),
        )
    }

    @Test
    fun `an answered Request leaves the Live Update for the next list, and removes an assistant alert`() {
        // Each apply brings the Live Updates in line with its decision, so the alert goes first.
        post(requestAlert)
        showLiveUpdates(buildWaitingUpdate())
        val decision = buildCommand("r1").decisions.first()

        finishAlertAction(context, AlertAction.Decide(ThreadAlertKey("s1"), LIVE_UPDATE_ID, "Fix 3-D Secure checkout", "Allow", "s1", "r1", decision), AlertActionOutcome.AlreadyAnswered)
        finishAlertAction(context, AlertAction.Decide(AssistantAlertKey("assistant-1"), ASSISTANT_ALERT_ID, "Poirot", "Allow", "s9", "r1", decision), AlertActionOutcome.AlreadyAnswered)

        assertEquals("thread:s1", manager.activeNotifications.single().tag)
    }

    @Test
    fun `a working thread's Live Update is posted silently on the working channel`() {
        showLiveUpdates(buildLiveUpdate(buildSession("s1"), emptyList(), alert = false))

        val posted = manager.activeNotifications.single()
        assertEquals("thread:s1", posted.tag)
        assertEquals(AlertChannels.WORKING, posted.notification.channelId)
        assertTrue(posted.isOngoing)

        showLiveUpdates()
        assertTrue(manager.activeNotifications.isEmpty())
    }
}

/**
 * Records the ids passed to `ShortcutManager.removeLongLivedShortcuts`, which Robolectric's
 * own shadow ignores. On a phone that call removes the shortcuts.
 */
@Implements(ShortcutManager::class)
class ShadowRecordingShortcutManager : ShadowShortcutManager() {
    @Implementation
    override fun removeLongLivedShortcuts(shortcutIds: List<String>) {
        removedLongLivedIds += shortcutIds
    }

    companion object {
        val removedLongLivedIds = mutableListOf<String>()
    }
}
