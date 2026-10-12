package dev.hercule.probe

import android.Manifest
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    enableEdgeToEdge()
    Probe.createChannels(this)
    requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS, Manifest.permission.RECORD_AUDIO), 1)
    setContent { MaterialTheme { Surface(Modifier.fillMaxSize()) { ProbeScreen() } } }
  }
}

@Composable
fun ProbeScreen() {
  val context = LocalContext.current
  val scope = rememberCoroutineScope()
  var report by remember { mutableStateOf(Probe.buildReport(context)) }
  fun postLater(post: () -> Unit) {
    scope.launch {
      delay(10_000)
      post()
      report = Probe.buildReport(context)
    }
  }
  Column(
    Modifier.fillMaxSize().safeDrawingPadding().padding(20.dp).verticalScroll(rememberScrollState()),
    verticalArrangement = Arrangement.spacedBy(10.dp),
  ) {
    Text("Hercule probe", style = MaterialTheme.typography.headlineSmall)
    Text("Each test posts 10 seconds after you tap it. Tap, then lock the phone straight away and wait.")
    Button({ postLater { Probe.postLiveUpdate(context) } }, Modifier.fillMaxWidth()) { Text("1. Live Update: thread waiting on you") }
    Button({ postLater { Probe.postApproval(context) } }, Modifier.fillMaxWidth()) { Text("2. Approval: Allow once / Deny") }
    Button({ postLater { Probe.postConversation(context) } }, Modifier.fillMaxWidth()) { Text("3. Message from Ada, with Reply") }
    Button({ Probe.checkSpeech(context) { report = Probe.buildReport(context) } }, Modifier.fillMaxWidth()) { Text("4. On-device speech recognition") }
    OutlinedButton({ Probe.openPromotionSettings(context) }, Modifier.fillMaxWidth()) { Text("Open Live Update settings for this app") }
    OutlinedButton({ Probe.clearAll(context); report = Probe.buildReport(context) }, Modifier.fillMaxWidth()) { Text("Clear notifications and results") }
    OutlinedButton({ report = Probe.buildReport(context) }, Modifier.fillMaxWidth()) { Text("Refresh results") }
    Text(report, fontFamily = FontFamily.Monospace, fontSize = 12.sp, lineHeight = 16.sp)
  }
}
