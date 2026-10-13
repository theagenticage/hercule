package dev.hercule.android.alerts

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.net.toUri
import dev.hercule.android.MainActivity
import dev.hercule.android.wire.ApprovalDecision

/**
 * The extra on the intent that opens [MainActivity] from an alert, a Live Update or a
 * shortcut. It holds the destination's [AlertKey.id]; read it back with [AlertKey.parse].
 */
const val EXTRA_ALERT_DESTINATION = "dev.hercule.android.extra.ALERT_DESTINATION"

/** A tap on an alert's button, as [AlertActionReceiver] receives it. */
sealed interface AlertAction {
    val key: AlertKey

    /** The id the tapped notification was posted under, with [key] as its tag. */
    val notificationId: Int

    /** The destination's title: the thread's title or the assistant's name. */
    val title: String

    /** The button's label, such as "Allow", which a failure names. */
    val buttonLabel: String

    data class Decide(
        override val key: AlertKey,
        override val notificationId: Int,
        override val title: String,
        override val buttonLabel: String,
        val sessionId: String,
        val requestId: String,
        val decision: ApprovalDecision,
    ) : AlertAction

    data class Pick(
        override val key: AlertKey,
        override val notificationId: Int,
        override val title: String,
        override val buttonLabel: String,
        val sessionId: String,
        val requestId: String,
        val header: String,
        val label: String,
    ) : AlertAction

    data class SendReply(
        override val key: AlertKey,
        override val notificationId: Int,
        override val title: String,
        override val buttonLabel: String,
        val conversationId: String,
    ) : AlertAction
}

/** Writes alert actions into intents and reads them back. */
internal object AlertIntents {
    /** The `RemoteInput` key the typed reply arrives under. */
    const val KEY_REPLY_TEXT = "reply_text"

    /**
     * Builds the broadcast a button sends to [AlertActionReceiver]. A reply's intent is
     * mutable, because Android adds the typed text to it.
     *
     * Each button gets its own data URI, so that the pending intents of different buttons,
     * destinations and Requests never replace each other. The Request's id is part of it:
     * otherwise a newer Request on the same thread would rewrite the extras of the button
     * already on screen, and a tap before the alert is redrawn would answer a Request the user
     * never saw.
     */
    fun buildActionIntent(context: Context, action: AlertAction): PendingIntent {
        // The Request the button answers, or the conversation a reply is sent to.
        val targetId = when (action) {
            is AlertAction.Decide -> action.requestId
            is AlertAction.Pick -> action.requestId
            is AlertAction.SendReply -> action.conversationId
        }
        val intent = Intent(context, AlertActionReceiver::class.java)
            .setAction(
                when (action) {
                    is AlertAction.Decide -> ACTION_DECIDE
                    is AlertAction.Pick -> ACTION_PICK
                    is AlertAction.SendReply -> ACTION_SEND_REPLY
                },
            )
            .setData(
                "hercule-alert://action/${Uri.encode(action.key.id)}/${action.notificationId}/${Uri.encode(targetId)}/${Uri.encode(action.buttonLabel)}"
                    .toUri(),
            )
            .putExtra(EXTRA_KEY, action.key.id)
            .putExtra(EXTRA_NOTIFICATION_ID, action.notificationId)
            .putExtra(EXTRA_TITLE, action.title)
            .putExtra(EXTRA_BUTTON_LABEL, action.buttonLabel)
        when (action) {
            is AlertAction.Decide -> intent
                .putExtra(EXTRA_SESSION_ID, action.sessionId)
                .putExtra(EXTRA_REQUEST_ID, action.requestId)
                .putExtra(EXTRA_DECISION, action.decision.wire)
            is AlertAction.Pick -> intent
                .putExtra(EXTRA_SESSION_ID, action.sessionId)
                .putExtra(EXTRA_REQUEST_ID, action.requestId)
                .putExtra(EXTRA_HEADER, action.header)
                .putExtra(EXTRA_LABEL, action.label)
            is AlertAction.SendReply -> intent.putExtra(EXTRA_CONVERSATION_ID, action.conversationId)
        }
        val mutability = if (action is AlertAction.SendReply) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or mutability)
    }

    /** Reads the action [buildActionIntent] wrote, or returns null for an intent it did not write. */
    fun readAction(intent: Intent): AlertAction? {
        val key = intent.getStringExtra(EXTRA_KEY)?.let(AlertKey::parse) ?: return null
        val notificationId = intent.getIntExtra(EXTRA_NOTIFICATION_ID, 0)
        val title = intent.getStringExtra(EXTRA_TITLE).orEmpty()
        val buttonLabel = intent.getStringExtra(EXTRA_BUTTON_LABEL).orEmpty()
        val sessionId = intent.getStringExtra(EXTRA_SESSION_ID)
        val requestId = intent.getStringExtra(EXTRA_REQUEST_ID)
        return when (intent.action) {
            ACTION_DECIDE -> AlertAction.Decide(
                key, notificationId, title, buttonLabel,
                sessionId ?: return null,
                requestId ?: return null,
                ApprovalDecision(intent.getStringExtra(EXTRA_DECISION) ?: return null),
            )
            ACTION_PICK -> AlertAction.Pick(
                key, notificationId, title, buttonLabel,
                sessionId ?: return null,
                requestId ?: return null,
                intent.getStringExtra(EXTRA_HEADER) ?: return null,
                intent.getStringExtra(EXTRA_LABEL) ?: return null,
            )
            ACTION_SEND_REPLY -> AlertAction.SendReply(
                key, notificationId, title, buttonLabel,
                intent.getStringExtra(EXTRA_CONVERSATION_ID) ?: return null,
            )
            else -> null
        }
    }

    /** Builds the intent that opens the app at the destination [key] names. */
    fun buildOpenIntent(context: Context, key: AlertKey): Intent =
        Intent(context, MainActivity::class.java)
            .setAction(Intent.ACTION_VIEW)
            .setData("hercule-alert://open/${Uri.encode(key.id)}".toUri())
            .putExtra(EXTRA_ALERT_DESTINATION, key.id)

    /** Wraps [buildOpenIntent] for a notification's tap and its Open button. */
    fun buildOpenPendingIntent(context: Context, key: AlertKey): PendingIntent =
        PendingIntent.getActivity(
            context,
            0,
            buildOpenIntent(context, key),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    private const val ACTION_DECIDE = "dev.hercule.android.action.ALERT_DECIDE"
    private const val ACTION_PICK = "dev.hercule.android.action.ALERT_PICK"
    private const val ACTION_SEND_REPLY = "dev.hercule.android.action.ALERT_SEND_REPLY"
    private const val EXTRA_KEY = "key"
    private const val EXTRA_NOTIFICATION_ID = "notification_id"
    private const val EXTRA_TITLE = "title"
    private const val EXTRA_BUTTON_LABEL = "button_label"
    private const val EXTRA_SESSION_ID = "session_id"
    private const val EXTRA_REQUEST_ID = "request_id"
    private const val EXTRA_DECISION = "decision"
    private const val EXTRA_HEADER = "header"
    private const val EXTRA_LABEL = "label"
    private const val EXTRA_CONVERSATION_ID = "conversation_id"
}
