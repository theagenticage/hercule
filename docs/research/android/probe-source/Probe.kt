package dev.hercule.probe

import android.app.KeyguardManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.os.Build
import android.provider.Settings
import android.speech.RecognitionSupport
import android.speech.RecognitionSupportCallback
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.core.content.LocusIdCompat
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Posts the four test notifications and keeps a log of what happened, so the results can be read back. */
object Probe {
  private const val TAG = "HerculeProbe"
  private const val CHANNEL_LIVE = "live"
  private const val CHANNEL_ASKS = "asks"
  private const val CHANNEL_MESSAGES = "messages"
  const val ID_LIVE = 1
  const val ID_APPROVAL = 2
  const val ID_MESSAGE = 3
  const val KEY_REPLY = "reply"

  fun createChannels(context: Context) {
    val manager = context.getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(NotificationChannel(CHANNEL_LIVE, "Working now", NotificationManager.IMPORTANCE_DEFAULT))
    manager.createNotificationChannel(NotificationChannel(CHANNEL_ASKS, "Waiting on you", NotificationManager.IMPORTANCE_HIGH))
    manager.createNotificationChannel(NotificationChannel(CHANNEL_MESSAGES, "Messages", NotificationManager.IMPORTANCE_HIGH))
  }

  fun record(context: Context, line: String) {
    val stamp = SimpleDateFormat("HH:mm:ss", Locale.ROOT).format(Date())
    val locked = context.getSystemService(KeyguardManager::class.java).isKeyguardLocked
    val entry = "$stamp ${if (locked) "[locked]" else "[unlocked]"} $line"
    Log.i(TAG, entry)
    val prefs = context.getSharedPreferences("probe", Context.MODE_PRIVATE)
    prefs.edit().putString("log", (prefs.getString("log", "") ?: "") + entry + "\n").apply()
  }

  fun buildReport(context: Context): String {
    val manager = context.getSystemService(NotificationManager::class.java)
    val facts = buildString {
      appendLine("Device: ${Build.MANUFACTURER} ${Build.MODEL}")
      appendLine("Android: ${Build.VERSION.RELEASE}, SDK_INT ${Build.VERSION.SDK_INT}, SDK_INT_FULL ${readSdkIntFull()}")
      appendLine("One UI: ${readSystemProperty("ro.build.version.oneui")}, build ${Build.DISPLAY}")
      appendLine("Notifications allowed: ${NotificationManagerCompat.from(context).areNotificationsEnabled()}")
      if (Build.VERSION.SDK_INT >= 36) appendLine("canPostPromotedNotifications: ${manager.canPostPromotedNotifications()}")
      appendLine("Speech recognition available: ${SpeechRecognizer.isRecognitionAvailable(context)}")
      appendLine("On-device speech available: ${SpeechRecognizer.isOnDeviceRecognitionAvailable(context)}")
    }
    val log = context.getSharedPreferences("probe", Context.MODE_PRIVATE).getString("log", "") ?: ""
    return facts + "\nLog:\n" + log
  }

  fun clearAll(context: Context) {
    NotificationManagerCompat.from(context).cancelAll()
    context.getSharedPreferences("probe", Context.MODE_PRIVATE).edit().clear().apply()
  }

  fun openPromotionSettings(context: Context) {
    val intent = Intent(Settings.ACTION_APP_NOTIFICATION_PROMOTION_SETTINGS)
      .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    runCatching { context.startActivity(intent) }.onFailure { record(context, "Live Update settings could not open: ${it.message}") }
  }

  /** Test 1: a session waiting on you as an Android 16 Live Update with a 4-step track. */
  fun postLiveUpdate(context: Context) {
    val peach = 0xFFE8956B.toInt()
    val you = 0xFF7A5CFA.toInt()
    val style = NotificationCompat.ProgressStyle()
      .setStyledByProgress(false)
      .setProgressSegments(
        listOf(
          NotificationCompat.ProgressStyle.Segment(25).setColor(peach),
          NotificationCompat.ProgressStyle.Segment(25).setColor(peach),
          NotificationCompat.ProgressStyle.Segment(25).setColor(peach),
          NotificationCompat.ProgressStyle.Segment(25).setColor(you),
        ),
      )
      .setProgress(75)
      .setProgressTrackerIcon(IconCompat.createWithBitmap(drawFace(48, peach)))
    val notification = NotificationCompat.Builder(context, CHANNEL_LIVE)
      .setSmallIcon(R.drawable.ic_stat)
      .setLargeIcon(drawFace(128, peach))
      .setContentTitle("Fix 3-D Secure checkout")
      .setContentText("Waiting on you · Run git push -u origin fix/3ds-eu-cards?")
      .setSubText("webshop")
      .setShortCriticalText("Push?")
      .setOngoing(true)
      .setRequestPromotedOngoing(true)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setStyle(style)
      .addAction(0, "Allow once", actionIntent(context, "live-allow", ID_LIVE))
      .addAction(0, "Deny", actionIntent(context, "live-deny", ID_LIVE))
      .build()
    val promotable = notification.extras.getBoolean(NotificationCompat.EXTRA_REQUEST_PROMOTED_ONGOING)
    notify(context, ID_LIVE, notification)
    // The system sets FLAG_PROMOTED_ONGOING on its own copy of the notification, not on the
    // object built here, so read the posted copy back to see whether promotion was granted.
    val posted = context.getSystemService(android.app.NotificationManager::class.java)
      .activeNotifications.firstOrNull { it.id == ID_LIVE }?.notification
    val promoted = posted != null && (posted.flags and android.app.Notification.FLAG_PROMOTED_ONGOING) != 0
    record(context, "posted Live Update (requested promotion: $promotable, promoted flag: $promoted)")
  }

  /** Test 2: a Request as a high-priority notification whose buttons are handled by a receiver, not an activity. */
  fun postApproval(context: Context) {
    val orchid = 0xFFC77DDB.toInt()
    val notification = NotificationCompat.Builder(context, CHANNEL_ASKS)
      .setSmallIcon(R.drawable.ic_stat)
      .setLargeIcon(drawFace(128, orchid))
      .setContentTitle("Ship release v2.15 · Request")
      .setContentText("Publish payments-api 2.15.0 to npm?")
      .setCategory(NotificationCompat.CATEGORY_REMINDER)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .addAction(NotificationCompat.Action.Builder(0, "Allow once", actionIntent(context, "allow", ID_APPROVAL)).setAuthenticationRequired(false).build())
      .addAction(NotificationCompat.Action.Builder(0, "Deny", actionIntent(context, "deny", ID_APPROVAL)).setAuthenticationRequired(false).build())
      .build()
    notify(context, ID_APPROVAL, notification)
    record(context, "posted approval")
  }

  /** Test 3: an assistant message as a conversation notification, backed by a long-lived sharing shortcut. */
  fun postConversation(context: Context) {
    val iris = 0xFF6F7BF7.toInt()
    val icon = IconCompat.createWithAdaptiveBitmap(drawAdaptiveFace(iris))
    val ada = Person.Builder().setName("Ada").setKey("assistant-ada").setIcon(icon).setImportant(true).build()
    val me = Person.Builder().setName("Rogier").setKey("me").build()
    val shortcut = ShortcutInfoCompat.Builder(context, "assistant-ada")
      .setLongLived(true)
      .setShortLabel("Ada")
      .setPerson(ada)
      .setIcon(icon)
      .setLocusId(LocusIdCompat("assistant-ada"))
      .setCategories(setOf("dev.hercule.probe.category.ASSISTANT"))
      .setIntent(Intent(context, MainActivity::class.java).setAction(Intent.ACTION_VIEW))
      .build()
    ShortcutManagerCompat.pushDynamicShortcut(context, shortcut)
    val reply = NotificationCompat.Action.Builder(0, "Reply", actionIntent(context, "reply", ID_MESSAGE, mutable = true))
      .addRemoteInput(RemoteInput.Builder(KEY_REPLY).setLabel("Message Ada…").build())
      .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
      .setAllowGeneratedReplies(true)
      .build()
    val style = NotificationCompat.MessagingStyle(me)
      .addMessage("Morning Rogier. One urgent thing: EU card payments that need 3-D Secure have failed since yesterday's deploy.", System.currentTimeMillis() - 60_000, ada)
      .addMessage("You started a fix at 09:02; it's waiting on your OK to push.", System.currentTimeMillis(), ada)
    val notification = NotificationCompat.Builder(context, CHANNEL_MESSAGES)
      .setSmallIcon(R.drawable.ic_stat)
      .setStyle(style)
      .setShortcutId("assistant-ada")
      .setLocusId(LocusIdCompat("assistant-ada"))
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .addAction(reply)
      .build()
    notify(context, ID_MESSAGE, notification)
    record(context, "posted message from Ada")
  }

  /** Test 4: whether Samsung offers on-device recognition, and for which languages. */
  fun checkSpeech(context: Context, done: () -> Unit) {
    if (!SpeechRecognizer.isOnDeviceRecognitionAvailable(context)) {
      record(context, "speech: no on-device recognizer")
      done()
      return
    }
    val recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
    val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).putExtra(RecognizerIntent.EXTRA_LANGUAGE, "en-US")
    recognizer.checkRecognitionSupport(intent, context.mainExecutor, object : RecognitionSupportCallback {
      override fun onSupportResult(support: RecognitionSupport) {
        record(context, "speech: installed ${support.installedOnDeviceLanguages}, pending ${support.pendingOnDeviceLanguages}, online ${support.onlineLanguages.take(5)}")
        recognizer.destroy()
        done()
      }
      override fun onError(error: Int) {
        record(context, "speech: support check failed with error $error")
        recognizer.destroy()
        done()
      }
    })
  }

  private fun notify(context: Context, id: Int, notification: android.app.Notification) {
    runCatching { NotificationManagerCompat.from(context).notify(id, notification) }
      .onFailure { record(context, "notify $id failed: ${it.message}") }
  }

  private fun actionIntent(context: Context, action: String, id: Int, mutable: Boolean = false): PendingIntent {
    val intent = Intent(context, ProbeReceiver::class.java).setAction(action).putExtra("id", id)
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or if (mutable) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE
    return PendingIntent.getBroadcast(context, action.hashCode(), intent, flags)
  }

  /** Draws a rough egg-shaped colleague; a stand-in for the real crew face. */
  private fun drawFace(size: Int, color: Int): Bitmap {
    val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    paintFace(Canvas(bitmap), size.toFloat(), 0f, color)
    return bitmap
  }

  /** Draws the face inside an adaptive icon's 108dp canvas, keeping it inside the 66dp safe zone. */
  private fun drawAdaptiveFace(color: Int): Bitmap {
    val size = 216
    val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    canvas.drawColor(0xFFEDEBFF.toInt())
    paintFace(canvas, size * 0.6f, size * 0.2f, color)
    return bitmap
  }

  private fun paintFace(canvas: Canvas, size: Float, offset: Float, color: Int) {
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = color }
    val path = Path().apply {
      moveTo(offset + size * 0.5f, offset + size * 0.06f)
      cubicTo(offset + size * 0.82f, offset + size * 0.06f, offset + size * 0.94f, offset + size * 0.5f, offset + size * 0.9f, offset + size * 0.7f)
      cubicTo(offset + size * 0.86f, offset + size * 0.9f, offset + size * 0.7f, offset + size * 0.96f, offset + size * 0.5f, offset + size * 0.96f)
      cubicTo(offset + size * 0.3f, offset + size * 0.96f, offset + size * 0.14f, offset + size * 0.9f, offset + size * 0.1f, offset + size * 0.7f)
      cubicTo(offset + size * 0.06f, offset + size * 0.5f, offset + size * 0.18f, offset + size * 0.06f, offset + size * 0.5f, offset + size * 0.06f)
      close()
    }
    canvas.drawPath(path, paint)
    paint.color = 0xFF2A2340.toInt()
    canvas.drawCircle(offset + size * 0.38f, offset + size * 0.52f, size * 0.05f, paint)
    canvas.drawCircle(offset + size * 0.62f, offset + size * 0.52f, size * 0.05f, paint)
  }

  private fun readSdkIntFull(): String =
    runCatching { Build.VERSION::class.java.getField("SDK_INT_FULL").getInt(null).toString() }.getOrDefault("n/a")

  private fun readSystemProperty(name: String): String =
    runCatching {
      Class.forName("android.os.SystemProperties").getMethod("get", String::class.java).invoke(null, name) as String
    }.getOrDefault("").ifEmpty { "n/a" }
}
