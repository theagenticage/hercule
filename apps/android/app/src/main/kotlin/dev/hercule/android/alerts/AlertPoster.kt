package dev.hercule.android.alerts

import android.Manifest
import android.app.Notification
import android.content.Context
import android.content.pm.PackageManager
import android.os.Bundle
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

/** The ids of the app's notification channels. The controller watch service posts on [CONNECTION]. */
object AlertChannels {
    /** Request alerts and the Live Updates of threads waiting on the user. High importance, so they pop up. */
    const val WAITING = "waiting"

    /** Assistant messages. High importance, so they pop up. */
    const val MESSAGES = "messages"

    /** The Live Update of the followed thread while it works. Default importance, and posted silently. */
    const val WORKING = "working"

    /** The controller watch service's ongoing notification. Minimum importance and silent. */
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
 * Posts and removes the assistant alerts and the Live Updates that [decideAlerts] decides.
 * Each is posted with its [AlertKey.id] as its tag, so a destination has one notification
 * at most.
 *
 * Every assistant alert is a conversation notification: `MessagingStyle`, a `Person` with
 * the face, and a long-lived shortcut whose id is the key. Only a conversation notification
 * draws the face on the left with the app as a badge, as the book does.
 */
class AlertPoster(private val context: Context, private val faces: AlertFaces) {
    private val manager = NotificationManagerCompat.from(context)

    /** The Live Updates this poster posted and has not ended, by tag. */
    private val postedLiveUpdates = HashMap<String, LiveUpdate>()
    private var hasEndedEarlierLiveUpdates = false

    /** Brings the posted alerts and Live Updates in line with [decision]. */
    fun apply(decision: AlertDecision) = synchronized(ShownAlerts) {
        for (change in decision.changes) {
            when (change) {
                is AlertChange.Post -> postAssistantAlert(change.alert, change.withSound)
                is AlertChange.Refresh -> {
                    val isShown = manager.activeNotifications.any { it.tag == change.key.id && it.id == ASSISTANT_ALERT_ID }
                    if (isShown) postAssistantAlert(change.alert, withSound = false)
                }
                // The assistant's sharing shortcut stays: the assistant is a lasting conversation.
                is AlertChange.Remove -> cancelAlert(context, change.key.id, ASSISTANT_ALERT_ID)
            }
        }
        showLiveUpdates(decision.liveUpdates)
    }

    /** Removes every alert, every Live Update and every shortcut, at sign-out. */
    fun clearAll() = synchronized(ShownAlerts) {
        manager.cancelAll()
        ShownAlerts.extras.clear()
        val shortcutIds = ShortcutManagerCompat.getShortcuts(
            context,
            ShortcutManagerCompat.FLAG_MATCH_DYNAMIC or ShortcutManagerCompat.FLAG_MATCH_CACHED,
        ).map { it.id }
        ShortcutManagerCompat.removeLongLivedShortcuts(context, shortcutIds)
        ShortcutManagerCompat.removeAllDynamicShortcuts(context)
        postedLiveUpdates.clear()
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
        builder.extras.putString(EXTRA_SHOWN_REQUEST_ID, alert.requestId)
        (alert.actions as? AlertActions.Reply)?.newestMessagePosition?.let { builder.extras.putLong(EXTRA_SHOWN_MESSAGE_POSITION, it) }
        addActions(builder, key, ASSISTANT_ALERT_ID, alert.assistantName, alert.actions)
        notify(key.id, ASSISTANT_ALERT_ID, builder.build())
    }

    /**
     * Posts each of [updates] and ends every other Live Update. A Live Update equal to the
     * one posted last for its thread is not posted again.
     */
    private fun showLiveUpdates(updates: List<LiveUpdate>) {
        val updatesByTag = updates.associateBy { ThreadAlertKey(it.sessionId).id }
        // The first time, read the posted notifications, so that Live Updates posted before
        // the process was restarted are ended too. Reading them is a call into the system, so
        // later calls rely on the ones this poster posted.
        val postedTags = if (hasEndedEarlierLiveUpdates) {
            postedLiveUpdates.keys.toList()
        } else {
            manager.activeNotifications.filter { it.id == LIVE_UPDATE_ID }.map { it.tag }
        }
        hasEndedEarlierLiveUpdates = true
        for (tag in postedTags - updatesByTag.keys) {
            cancelAlert(context, tag, LIVE_UPDATE_ID)
            postedLiveUpdates.remove(tag)
        }
        for ((tag, update) in updatesByTag) {
            if (postedLiveUpdates[tag] == update) continue
            postLiveUpdate(update)
            postedLiveUpdates[tag] = update
        }
    }

    /**
     * Posts [update] as its thread's Live Update. While the thread waits, it goes on the
     * channel of Request alerts, so a new Request pops up.
     */
    private fun postLiveUpdate(update: LiveUpdate) {
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
        val channel = if (update.isWaiting) AlertChannels.WAITING else AlertChannels.WORKING
        val builder = NotificationCompat.Builder(context, channel)
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
        builder.extras.putString(EXTRA_SHOWN_REQUEST_ID, update.requestId)
        update.actions?.let { addActions(builder, key, LIVE_UPDATE_ID, update.title, it) }
        notify(key.id, LIVE_UPDATE_ID, builder.build())
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
        key: AssistantAlertKey,
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
            .setGroup(GROUP_ASSISTANT_ALERTS)
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
                val label = context.getString(if (decision == ApprovalDecision.Allow) R.string.alert_allow else R.string.alert_deny)
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
                val action = AlertAction.SendReply(key, notificationId, title, label, actions.conversationId, actions.newestMessagePosition)
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
 * - success removes a replied assistant alert. An assistant's Request alert and a Live
 *   Update stay, because the next list posts them again with what is open then;
 * - `invalid_state` means the Request was answered elsewhere, so an assistant's alert is
 *   just removed, and a Live Update waits for the next list;
 * - a failure replaces the alert with one that says what failed and why. The Live Update
 *   keeps its buttons and only its text changes, so it stays the thread's one notification.
 *
 * Does nothing when the notification the button belongs to shows another Request or a newer
 * assistant message by now: the outcome is about the alert the user tapped, not the newer one.
 */
internal fun finishAlertAction(context: Context, action: AlertAction, outcome: AlertActionOutcome): Unit = synchronized(ShownAlerts) {
    val manager = NotificationManagerCompat.from(context)
    val posted = manager.activeNotifications.find { it.tag == action.key.id && it.id == action.notificationId }
    // The system lists a new notification only some time after it is posted, so what this
    // process posted last decides. The system's list is read only after a process restart.
    val shownExtras = ShownAlerts.extras[action.key.id to action.notificationId] ?: posted?.notification?.extras
    if (shownExtras != null && !isShowingTappedAlert(shownExtras, action)) return
    when (outcome) {
        AlertActionOutcome.Done ->
            if (action is AlertAction.SendReply) cancelAlert(context, action.key.id, action.notificationId)
        AlertActionOutcome.AlreadyAnswered ->
            if (action.notificationId != LIVE_UPDATE_ID) cancelAlert(context, action.key.id, action.notificationId)
        is AlertActionOutcome.Failed -> {
            val text = context.getString(R.string.alert_action_failed, action.buttonLabel, outcome.reason)
            val notification = if (action.notificationId == LIVE_UPDATE_ID && posted != null) {
                Notification.Builder.recoverBuilder(context, posted.notification).setContentText(text).build()
            } else {
                NotificationCompat.Builder(context, AlertChannels.WAITING)
                    .setSmallIcon(R.drawable.ic_stat_mark)
                    .setContentTitle(action.title)
                    .setContentText(text)
                    .setGroup(if (action.notificationId == LIVE_UPDATE_ID) GROUP_LIVE_UPDATE else GROUP_ASSISTANT_ALERTS)
                    .setContentIntent(AlertIntents.buildOpenPendingIntent(context, action.key))
                    .setAutoCancel(true)
                    .build()
            }
            notifyIfAllowed(context, action.key.id, action.notificationId, notification)
        }
    }
}

/** Checks whether a posted notification's [extras] still show the alert whose button sent [action]. */
private fun isShowingTappedAlert(extras: Bundle, action: AlertAction): Boolean {
    val shownMessagePosition = if (extras.containsKey(EXTRA_SHOWN_MESSAGE_POSITION)) extras.getLong(EXTRA_SHOWN_MESSAGE_POSITION) else null
    val tappedMessagePosition = (action as? AlertAction.SendReply)?.newestMessagePosition
    return extras.getString(EXTRA_SHOWN_REQUEST_ID) == readTappedRequestId(action) && shownMessagePosition == tappedMessagePosition
}

/** Returns the id of the Request a button answers, or null for Reply, which answers none. */
private fun readTappedRequestId(action: AlertAction): String? = when (action) {
    is AlertAction.Decide -> action.requestId
    is AlertAction.Pick -> action.requestId
    is AlertAction.SendReply -> null
}

/**
 * The extra on every alert and Live Update that holds the id of the Request it shows. It is
 * absent when the notification shows no Request.
 */
private const val EXTRA_SHOWN_REQUEST_ID = "dev.hercule.android.extra.SHOWN_REQUEST_ID"
private const val EXTRA_SHOWN_MESSAGE_POSITION = "dev.hercule.android.extra.SHOWN_MESSAGE_POSITION"

/**
 * Posts [notification] when the user lets the app post notifications, and drops it
 * otherwise. The app asks for that permission at sign-in.
 */
private fun notifyIfAllowed(context: Context, tag: String, id: Int, notification: Notification) {
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
    NotificationManagerCompat.from(context).notify(tag, id, notification)
    ShownAlerts.extras[tag to id] = notification.extras
}

/** Removes the notification posted as [tag] and [id], and forgets what it showed. */
private fun cancelAlert(context: Context, tag: String, id: Int) {
    NotificationManagerCompat.from(context).cancel(tag, id)
    ShownAlerts.extras.remove(tag to id)
}

/**
 * The extras of each notification this process posted, by tag and id, and the lock that
 * posting and ending an alert button's call both hold. Without the lock, a call could check
 * the alert the user tapped, and then remove a newer alert posted in between.
 */
private object ShownAlerts {
    val extras = HashMap<Pair<String, Int>, Bundle>()
}

/*
 * A notification is identified by its tag and its id together. Every alert's tag is its
 * key, so these ids only tell the kinds apart and never collide with an untagged
 * notification such as the controller watch service's.
 */
internal const val ASSISTANT_ALERT_ID = 2
internal const val LIVE_UPDATE_ID = 3

private const val GROUP_ASSISTANT_ALERTS = "assistant-alerts"
private const val GROUP_LIVE_UPDATE = "live-update"

/** Every segment of the Live Update's track has the same length. */
private const val SEGMENT_LENGTH = 100
