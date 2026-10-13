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

    private fun post(alert: Alert) = poster.apply(AlertDecision(AlertMemory(), listOf(AlertChange.Post(alert, withSound = true)), null))

    private val threadAlert = ThreadRequestAlert(
        sessionId = "s1",
        threadTitle = "Fix 3-D Secure checkout",
        heading = "Fix 3-D Secure checkout · Request",
        message = "Run pnpm test cart?",
        requestId = "r1",
        actions = decideAlertActions("s1", buildCommand("r1")),
        at = AT,
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
    fun `posts a thread alert as a conversation with its shortcut and its two buttons`() {
        post(threadAlert)

        val posted = manager.activeNotifications.single()
        assertEquals("thread:s1", posted.tag)
        assertEquals("thread:s1", posted.notification.shortcutId)
        assertEquals(AlertChannels.WAITING, posted.notification.channelId)
        val style = assertNotNull(NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(posted.notification))
        assertEquals("Run pnpm test cart?", style.messages.single().text)
        assertEquals(listOf("Allow once", "Deny"), posted.notification.actions.map { it.title })
        assertTrue(ShortcutManagerCompat.getDynamicShortcuts(context).any { it.id == "thread:s1" })
    }

    @Test
    fun `a thread alert's title is the heading and its text is the question, the thread named once`() {
        post(threadAlert.copy(message = "Run pnpm test cart?\n+1 more waiting"))

        // The lock screen, the pop-up and a watch show these two extras. Android builds the
        // title from the conversation title and the sender, so naming both after the thread
        // showed the thread's title twice.
        val extras = manager.activeNotifications.single().notification.extras
        assertEquals("Fix 3-D Secure checkout · Request", extras.getCharSequence(NotificationCompat.EXTRA_TITLE).toString())
        assertEquals("Run pnpm test cart?\n+1 more waiting", extras.getCharSequence(NotificationCompat.EXTRA_TEXT).toString())
    }

    @Test
    fun `posts an assistant alert with a Reply that takes text`() {
        post(AssistantAlert("assistant-1", "Poirot", listOf(AlertMessage("Done.", fromOwner = false, AT)), null, AlertActions.Reply("c1")))

        val posted = manager.activeNotifications.single()
        assertEquals(AlertChannels.MESSAGES, posted.notification.channelId)
        val reply = posted.notification.actions.single()
        assertEquals("Reply", reply.title)
        assertEquals(AlertIntents.KEY_REPLY_TEXT, reply.remoteInputs.single().resultKey)
    }

    @Test
    @Config(shadows = [ShadowRecordingShortcutManager::class])
    fun `removing a thread alert removes its notification and its shortcut`() {
        post(threadAlert)
        poster.apply(AlertDecision(AlertMemory(), listOf(AlertChange.Remove(ThreadAlertKey("s1"))), null))

        assertTrue(manager.activeNotifications.isEmpty())
        assertEquals(listOf("thread:s1"), ShadowRecordingShortcutManager.removedLongLivedIds)
    }

    @Test
    @Config(shadows = [ShadowRecordingShortcutManager::class])
    fun `removing an assistant alert keeps the assistant's sharing shortcut`() {
        post(AssistantAlert("assistant-1", "Poirot", listOf(AlertMessage("Done.", fromOwner = false, AT)), null, AlertActions.Reply("c1")))
        poster.apply(AlertDecision(AlertMemory(), listOf(AlertChange.Remove(AssistantAlertKey("assistant-1"))), null))

        assertTrue(manager.activeNotifications.isEmpty())
        assertEquals(emptyList(), ShadowRecordingShortcutManager.removedLongLivedIds)
    }

    @Test
    fun `a refresh replaces an alert on screen, and leaves a swiped-away alert away`() {
        val refresh = AlertDecision(AlertMemory(), listOf(AlertChange.Refresh(threadAlert.copy(message = "Run git push?"))), null)
        post(threadAlert)

        poster.apply(refresh)
        val text = manager.activeNotifications.single().notification.extras.getCharSequence(NotificationCompat.EXTRA_TEXT)
        assertEquals("Run git push?", text.toString())

        // The user swipes the alert away.
        manager.cancel("thread:s1", THREAD_ALERT_ID)
        poster.apply(refresh)
        assertTrue(manager.activeNotifications.isEmpty())
    }

    @Test
    fun `clears every alert and shortcut at sign-out`() {
        post(threadAlert)
        poster.clearAll()

        assertTrue(manager.activeNotifications.isEmpty())
        assertTrue(ShortcutManagerCompat.getDynamicShortcuts(context).isEmpty())
    }

    @Test
    fun `replaces an alert with what failed when a button's call fails`() {
        post(threadAlert)
        val action = AlertAction.Decide(ThreadAlertKey("s1"), THREAD_ALERT_ID, "Fix 3-D Secure checkout", "Allow once", "s1", "r1", buildCommand("r1").decisions.first())
        finishAlertAction(context, action, AlertActionOutcome.Failed("the controller did not answer in time"))

        val posted = manager.activeNotifications.single()
        assertEquals(
            "Allow once failed: the controller did not answer in time",
            posted.notification.extras.getCharSequence(NotificationCompat.EXTRA_TEXT).toString(),
        )
    }

    @Test
    fun `a button's outcome leaves alone an alert that shows a newer Request by now`() {
        post(threadAlert.copy(requestId = "r2"))
        val tappedOnR1 = AlertAction.Decide(ThreadAlertKey("s1"), THREAD_ALERT_ID, "Fix 3-D Secure checkout", "Allow once", "s1", "r1", buildCommand("r1").decisions.first())

        for (outcome in listOf(AlertActionOutcome.Done, AlertActionOutcome.AlreadyAnswered, AlertActionOutcome.Failed("timeout"))) {
            finishAlertAction(context, tappedOnR1, outcome)

            val posted = manager.activeNotifications.single()
            assertEquals("Run pnpm test cart?", posted.notification.extras.getCharSequence(NotificationCompat.EXTRA_TEXT).toString())
        }
    }

    @Test
    fun `a sent reply leaves alone an assistant alert that shows a Request by now`() {
        val request = AlertMessage("Run pnpm test cart?", fromOwner = false, AT)
        post(AssistantAlert("assistant-1", "Poirot", listOf(request), "r1", decideAlertActions("s9", buildCommand("r1"))))
        val reply = AlertAction.SendReply(AssistantAlertKey("assistant-1"), ASSISTANT_ALERT_ID, "Poirot", "Reply", "c1")

        finishAlertAction(context, reply, AlertActionOutcome.Done)

        assertEquals("assistant:assistant-1", manager.activeNotifications.single().tag)
    }

    @Test
    fun `a failed Live Update button says so in the Live Update itself`() {
        val waiting = buildSession("s1", openRequests = listOf(buildCommand("r1")))
        poster.apply(AlertDecision(AlertMemory(), emptyList(), buildLiveUpdate(waiting, emptyList(), alert = false)))
        val action = AlertAction.Decide(ThreadAlertKey("s1"), LIVE_UPDATE_ID, "Fix 3-D Secure checkout", "Allow once", "s1", "r1", buildCommand("r1").decisions.first())

        finishAlertAction(context, action, AlertActionOutcome.Failed("the controller did not answer in time"))

        val posted = manager.activeNotifications.single()
        assertEquals(LIVE_UPDATE_ID, posted.id)
        assertTrue(posted.isOngoing)
        assertEquals(
            "Allow once failed: the controller did not answer in time",
            posted.notification.extras.getCharSequence(NotificationCompat.EXTRA_TEXT).toString(),
        )
        assertEquals(listOf("Allow once", "Deny"), posted.notification.actions.map { it.title })
        assertEquals(
            Notification.ProgressStyle::class.java.name,
            posted.notification.extras.getString(Notification.EXTRA_TEMPLATE),
        )

        // The rebuilt Live Update still shows r1, so a second tap's failure replaces the first.
        finishAlertAction(context, action, AlertActionOutcome.Failed("the runner is offline"))
        assertEquals(
            "Allow once failed: the runner is offline",
            manager.activeNotifications.single().notification.extras.getCharSequence(NotificationCompat.EXTRA_TEXT).toString(),
        )
    }

    @Test
    fun `removes a thread alert when its Request was answered elsewhere`() {
        post(threadAlert)
        val action = AlertAction.Decide(ThreadAlertKey("s1"), THREAD_ALERT_ID, "Fix 3-D Secure checkout", "Allow once", "s1", "r1", buildCommand("r1").decisions.first())
        finishAlertAction(context, action, AlertActionOutcome.AlreadyAnswered)

        assertTrue(manager.activeNotifications.isEmpty())
    }

    @Test
    fun `posts the Live Update once and ends it when no thread is followed`() {
        val update = buildLiveUpdate(buildSession("s1"), emptyList(), alert = false)
        poster.apply(AlertDecision(AlertMemory(), emptyList(), update))

        val posted = manager.activeNotifications.single()
        assertEquals("thread:s1", posted.tag)
        assertEquals(AlertChannels.WORKING, posted.notification.channelId)
        assertTrue(posted.isOngoing)

        poster.apply(AlertDecision(AlertMemory(), emptyList(), null))
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
