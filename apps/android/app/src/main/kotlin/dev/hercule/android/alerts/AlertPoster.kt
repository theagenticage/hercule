package dev.hercule.android.alerts

import android.Manifest
import android.app.Notification
import android.content.Context
import android.content.pm.PackageManager
import androidx.compose.ui.graphics.toArgb
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat
import androidx.core.content.LocusIdCompat
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import dev.hercule.android.R
import dev.hercule.android.theme.OrientExpressColors
import dev.hercule.android.theme.WhitehavenColors
import dev.hercule.android.wire.ApprovalDecision

/** The ids of the app's notification channels. The connection service posts on [CONNECTION]. */
object AlertChannels {
    /** Request alerts. High importance, so they pop up. */
    const val WAITING = "waiting"

    /** Assistant messages. High importance, so they pop up. */
    const val MESSAGES = "messages"

    /** The Live Update. Default importance: it sounds once when a Request opens, without popping up. */
    const val WORKING = "working"

    /** The connection service's ongoing notification. Minimum importance and silent. */
    const val CONNECTION = "connection"
}

/**
 * Creates the four notification channels, at app start and before anything is posted.
 * Creating a channel that exists only renames it, so calling this again is harmless.
 */
fun createAlertChannels(context: Context) {
    fun buildChannel(id: String, name: Int, importance: Int) =
        NotificationChannelCompat.Builder(id, importance).setName(context.getString(name))
    NotificationManagerCompat.from(context).createNotificationChannelsCompat(
        listOf(
            buildChannel(AlertChannels.WAITING, R.string.channel_waiting, NotificationManagerCompat.IMPORTANCE_HIGH).build(),
            buildChannel(AlertChannels.MESSAGES, R.string.channel_messages, NotificationManagerCompat.IMPORTANCE_HIGH).build(),
            buildChannel(AlertChannels.WORKING, R.string.channel_working, NotificationManagerCompat.IMPORTANCE_DEFAULT).build(),
            buildChannel(AlertChannels.CONNECTION, R.string.channel_connection, NotificationManagerCompat.IMPORTANCE_MIN)
                .setSound(null, null)
                .setVibrationEnabled(false)
                .setShowBadge(false)
                .build(),
        ),
    )
}

/**
 * Posts and removes the alerts and the Live Update that [decideAlerts] decides. Each alert
 * is posted with its [AlertKey.id] as its tag, so a destination has one alert at most.
 *
 * Every alert is a conversation notification: `MessagingStyle`, a `Person` with the face,
 * and a long-lived shortcut whose id is the key. Only a conversation notification draws the
 * face on the left with the app as a badge, as the book does.
 */
class AlertPoster(private val context: Context, private val faces: AlertFaces) {
    private val manager = NotificationManagerCompat.from(context)
    private var postedLiveUpdate: LiveUpdate? = null

    /** Brings the posted alerts and the Live Update in line with [decision]. */
    fun apply(decision: AlertDecision) {
        for (change in decision.changes) {
            when (change) {
                is AlertChange.Post -> when (val alert = change.alert) {
                    is ThreadRequestAlert -> postThreadAlert(alert, change.withSound)
                    is AssistantAlert -> postAssistantAlert(alert, change.withSound)
                }
                is AlertChange.Remove -> {
                    manager.cancel(change.key.id, notificationIdFor(change.key))
                    // A thread's shortcut lives only while something waits on it, so the share
                    // sheet and the launcher do not fill up with old threads.
                    ShortcutManagerCompat.removeLongLivedShortcuts(context, listOf(change.key.id))
                }
            }
        }
        showLiveUpdate(decision.liveUpdate)
    }

    /** Removes every alert, the Live Update and every shortcut, at sign-out. */
    fun clearAll() {
        manager.cancelAll()
        val shortcutIds = ShortcutManagerCompat.getShortcuts(
            context,
            ShortcutManagerCompat.FLAG_MATCH_DYNAMIC or ShortcutManagerCompat.FLAG_MATCH_CACHED,
        ).map { it.id }
        ShortcutManagerCompat.removeLongLivedShortcuts(context, shortcutIds)
        ShortcutManagerCompat.removeAllDynamicShortcuts(context)
        postedLiveUpdate = null
    }

    private fun postThreadAlert(alert: ThreadRequestAlert, withSound: Boolean) {
        val key = alert.key
        val icon = faces.drawPersonIcon(alert.sessionId, isAssistant = false, AlertFacePose.Waiting)
        val colleague = buildPerson(key, alert.threadTitle, icon)
        pushShortcut(key, alert.threadTitle, alert.heading, colleague, icon)
        val style = NotificationCompat.MessagingStyle(buildOwner())
            .setConversationTitle(alert.heading)
            .addMessage(alert.message, alert.at.toEpochMilliseconds(), colleague)
        val builder = buildConversation(key, AlertChannels.WAITING, style, withSound)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        addActions(builder, key, THREAD_ALERT_ID, alert.threadTitle, alert.actions)
        notify(key.id, THREAD_ALERT_ID, builder.build())
    }

    private fun postAssistantAlert(alert: AssistantAlert, withSound: Boolean) {
        val key = alert.key
        val pose = if (alert.requestId != null) AlertFacePose.Waiting else AlertFacePose.Idle
        val icon = faces.drawPersonIcon(alert.assistantId, isAssistant = true, pose)
        val assistant = buildPerson(key, alert.assistantName, icon)
        pushShortcut(key, alert.assistantName, alert.assistantName, assistant, icon)
        val style = NotificationCompat.MessagingStyle(buildOwner())
        for (message in alert.messages) {
            style.addMessage(message.text, message.at.toEpochMilliseconds(), if (message.fromOwner) null else assistant)
        }
        val channel = if (alert.requestId != null) AlertChannels.WAITING else AlertChannels.MESSAGES
        val builder = buildConversation(key, channel, style, withSound)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
        addActions(builder, key, ASSISTANT_ALERT_ID, alert.assistantName, alert.actions)
        notify(key.id, ASSISTANT_ALERT_ID, builder.build())
    }

    /**
     * Posts [update], ends any other thread's Live Update, and ends this one when [update] is
     * null. A Live Update equal to the one posted last is not posted again.
     */
    private fun showLiveUpdate(update: LiveUpdate?) {
        val tag = update?.let { ThreadAlertKey(it.sessionId).id }
        // Read the posted notifications rather than a field, so that a Live Update posted
        // before the process was restarted is ended too.
        for (posted in manager.activeNotifications) {
            if (posted.id == LIVE_UPDATE_ID && posted.tag != tag) manager.cancel(posted.tag, LIVE_UPDATE_ID)
        }
        if (update == null || update == postedLiveUpdate) {
            postedLiveUpdate = update
            return
        }
        val key = ThreadAlertKey(update.sessionId)
        val hue = faces.readHueColor(update.sessionId)
        val segments = List(update.doneSteps) { NotificationCompat.ProgressStyle.Segment(SEGMENT_LENGTH).setColor(hue) } +
            NotificationCompat.ProgressStyle.Segment(SEGMENT_LENGTH).setColor(if (update.isWaiting) readYouColor() else hue)
        val pose = if (update.isWaiting) AlertFacePose.Waiting else AlertFacePose.Working
        val style = NotificationCompat.ProgressStyle()
            // While working, the last segment is drawn unfilled; while waiting, it is drawn
            // in full in the "you" colour.
            .setStyledByProgress(!update.isWaiting)
            .setProgressSegments(segments)
            .setProgress(update.doneSteps * SEGMENT_LENGTH)
            .setProgressTrackerIcon(faces.drawTrackerIcon(update.sessionId, pose))
        val builder = NotificationCompat.Builder(context, AlertChannels.WORKING)
            .setSmallIcon(R.drawable.ic_stat_mark)
            .setContentTitle(update.title)
            .setContentText(update.text)
            .setShortCriticalText(update.shortText)
            .setStyle(style)
            .setOngoing(true)
            .setRequestPromotedOngoing(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setGroup(GROUP_LIVE_UPDATE)
            .setContentIntent(AlertIntents.buildOpenPendingIntent(context, key))
            .setSilent(!update.alert)
        update.actions?.let { addActions(builder, key, LIVE_UPDATE_ID, update.title, it) }
        notify(key.id, LIVE_UPDATE_ID, builder.build())
        postedLiveUpdate = update
    }

    /** Builds the user's own side of a conversation. */
    private fun buildOwner(): Person = Person.Builder().setName(context.getString(R.string.alert_you)).build()

    private fun buildPerson(key: AlertKey, name: String, icon: IconCompat): Person =
        Person.Builder().setName(name).setKey(key.id).setIcon(icon).setImportant(true).build()

    /**
     * Publishes the destination's long-lived shortcut, which a conversation notification
     * needs before it is posted. Android draws [longLabel] as the conversation's title.
     */
    private fun pushShortcut(key: AlertKey, shortLabel: String, longLabel: String, person: Person, icon: IconCompat) {
        val shortcut = ShortcutInfoCompat.Builder(context, key.id)
            .setLongLived(true)
            .setShortLabel(shortLabel)
            .setLongLabel(longLabel)
            .setPerson(person)
            .setIcon(icon)
            .setLocusId(LocusIdCompat(key.id))
            .setIntent(AlertIntents.buildOpenIntent(context, key))
            .build()
        ShortcutManagerCompat.pushDynamicShortcut(context, shortcut)
    }

    private fun buildConversation(
        key: AlertKey,
        channel: String,
        style: NotificationCompat.MessagingStyle,
        withSound: Boolean,
    ): NotificationCompat.Builder =
        NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_stat_mark)
            .setStyle(style)
            .setShortcutId(key.id)
            .setLocusId(LocusIdCompat(key.id))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            // Without a group of its own, Android bundles the app's notifications into one
            // collapsed card.
            .setGroup(if (key is ThreadAlertKey) GROUP_THREAD_ALERTS else GROUP_ASSISTANT_ALERTS)
            .setContentIntent(AlertIntents.buildOpenPendingIntent(context, key))
            .setAutoCancel(true)
            .setSilent(!withSound)

    /** Adds the buttons [actions] names, each sending its tap to [AlertActionReceiver]. */
    private fun addActions(
        builder: NotificationCompat.Builder,
        key: AlertKey,
        notificationId: Int,
        title: String,
        actions: AlertActions,
    ) {
        when (actions) {
            is AlertActions.Approve -> for (decision in actions.decisions) {
                val label = context.getString(if (decision == ApprovalDecision.Allow) R.string.alert_allow_once else R.string.alert_deny)
                val action = AlertAction.Decide(key, notificationId, title, label, actions.sessionId, actions.requestId, decision)
                builder.addAction(NotificationCompat.Action.Builder(null, label, AlertIntents.buildActionIntent(context, action)).build())
            }
            is AlertActions.PickOption -> for (label in actions.labels) {
                val action = AlertAction.Pick(key, notificationId, title, label, actions.sessionId, actions.requestId, actions.header, label)
                builder.addAction(NotificationCompat.Action.Builder(null, label, AlertIntents.buildActionIntent(context, action)).build())
            }
            AlertActions.Open -> builder.addAction(
                NotificationCompat.Action.Builder(
                    null,
                    context.getString(R.string.alert_open),
                    AlertIntents.buildOpenPendingIntent(context, key),
                ).build(),
            )
            is AlertActions.Reply -> {
                val label = context.getString(R.string.alert_reply)
                val action = AlertAction.SendReply(key, notificationId, title, label, actions.conversationId)
                val input = RemoteInput.Builder(AlertIntents.KEY_REPLY_TEXT)
                    .setLabel(context.getString(R.string.alert_reply_hint, title))
                    .build()
                builder.addAction(
                    NotificationCompat.Action.Builder(null, label, AlertIntents.buildActionIntent(context, action))
                        .addRemoteInput(input)
                        .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
                        // One UI's smart replies ("Okay", "Got it, thanks") stay on.
                        .setAllowGeneratedReplies(true)
                        .build(),
                )
            }
        }
    }

    /** Returns the "you" colour of the theme the phone shows now. */
    private fun readYouColor(): Int {
        val isDark = context.resources.configuration.isNightModeActive
        return (if (isDark) OrientExpressColors.you else WhitehavenColors.you).toArgb()
    }

    private fun notify(tag: String, id: Int, notification: Notification) = notifyIfAllowed(context, tag, id, notification)
}

/**
 * Ends an alert button's call with [outcome]:
 *
 * - success removes a thread's alert and a replied assistant alert. An assistant's Request
 *   alert and the Live Update stay, because the next list posts them again with what is
 *   open then;
 * - `invalid_state` means the Request was answered elsewhere, so the alert is just removed;
 * - a failure replaces the alert with one that says what failed and why.
 */
internal fun finishAlertAction(context: Context, action: AlertAction, outcome: AlertActionOutcome) {
    val manager = NotificationManagerCompat.from(context)
    when (outcome) {
        AlertActionOutcome.Done ->
            if (action.notificationId == THREAD_ALERT_ID || action is AlertAction.SendReply) {
                manager.cancel(action.key.id, action.notificationId)
            }
        AlertActionOutcome.AlreadyAnswered ->
            if (action.notificationId != LIVE_UPDATE_ID) manager.cancel(action.key.id, action.notificationId)
        is AlertActionOutcome.Failed -> {
            // The Live Update keeps showing the Request, so its failure goes beside it, in
            // the thread's alert.
            val id = if (action.notificationId == LIVE_UPDATE_ID) THREAD_ALERT_ID else action.notificationId
            val notification = NotificationCompat.Builder(context, AlertChannels.WAITING)
                .setSmallIcon(R.drawable.ic_stat_mark)
                .setContentTitle(action.title)
                .setContentText(context.getString(R.string.alert_action_failed, action.buttonLabel, outcome.reason))
                .setGroup(if (action.key is ThreadAlertKey) GROUP_THREAD_ALERTS else GROUP_ASSISTANT_ALERTS)
                .setContentIntent(AlertIntents.buildOpenPendingIntent(context, action.key))
                .setAutoCancel(true)
                .build()
            notifyIfAllowed(context, action.key.id, id, notification)
        }
    }
}

/**
 * Posts [notification] when the user lets the app post notifications, and drops it
 * otherwise. The app asks for that permission at sign-in.
 */
private fun notifyIfAllowed(context: Context, tag: String, id: Int, notification: Notification) {
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
    NotificationManagerCompat.from(context).notify(tag, id, notification)
}

/** Returns the notification id a destination's alert is posted under, beside its key as the tag. */
private fun notificationIdFor(key: AlertKey): Int = when (key) {
    is ThreadAlertKey -> THREAD_ALERT_ID
    is AssistantAlertKey -> ASSISTANT_ALERT_ID
}

/*
 * A notification is identified by its tag and its id together. Every alert's tag is its
 * key, so these ids only tell the kinds apart and never collide with an untagged
 * notification such as the connection service's.
 */
internal const val THREAD_ALERT_ID = 1
internal const val ASSISTANT_ALERT_ID = 2
internal const val LIVE_UPDATE_ID = 3

private const val GROUP_THREAD_ALERTS = "thread-alerts"
private const val GROUP_ASSISTANT_ALERTS = "assistant-alerts"
private const val GROUP_LIVE_UPDATE = "live-update"

/** Every segment of the Live Update's track has the same length. */
private const val SEGMENT_LENGTH = 100
