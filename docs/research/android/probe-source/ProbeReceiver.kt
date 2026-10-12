package dev.hercule.probe

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput

/** Records each notification button press, with whether the phone was locked at the time. */
class ProbeReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val id = intent.getIntExtra("id", 0)
    val typed = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(Probe.KEY_REPLY)
    Probe.record(context, "action '${intent.action}' on notification $id" + (typed?.let { " with text \"$it\"" } ?: ""))
    NotificationManagerCompat.from(context).cancel(id)
  }
}
