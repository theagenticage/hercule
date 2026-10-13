package dev.hercule.android.ui.you

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import dev.hercule.android.controller.LiveConnectionState
import dev.hercule.android.theme.BoldWeight
import dev.hercule.android.theme.MediumWeight
import dev.hercule.android.ui.BureauIcon
import dev.hercule.android.ui.BureauIcons
import dev.hercule.android.ui.Hairline
import dev.hercule.android.ui.Tab
import dev.hercule.android.ui.TabBar
import dev.hercule.android.ui.bureauColors
import dev.hercule.android.ui.buildMonoTextStyle
import dev.hercule.android.ui.buildUiTextStyle

/** The licence of a font the app ships: the font's [name] and the licence's full [text]. */
data class FontLicence(val name: String, val text: String)

/**
 * What the You screen draws:
 *
 * - [username] and [controllerUrl], the account the app is signed in with;
 * - [connection], where the live connection to the controller stands;
 * - [showsOneUiNote], true on a Samsung phone, whose One UI shows Live Updates only once a
 *   developer option is on;
 * - [licences], the licences of the fonts the app ships;
 * - [waitingCount], how many colleagues wait on the user, on the tab bar's Threads tab.
 */
data class YouUiState(
    val username: String,
    val controllerUrl: String,
    val connection: LiveConnectionState,
    val showsOneUiNote: Boolean,
    val licences: List<FontLicence>,
    val waitingCount: Int,
)

/**
 * Draws the You screen, in the shape of the book's mobile/settings.html: the account and the
 * live connection with Sign out, the two phone settings that keep alerts arriving, and the font
 * licences, which open in place. [onSignOut] signs out; [onSelectTab] switches tabs.
 *
 * The book's You screen lists the controller's settings, which the app does not edit; this
 * screen keeps its look and holds only what the phone itself needs.
 */
@Composable
fun YouScreen(
    state: YouUiState,
    onSignOut: () -> Unit,
    onSelectTab: (Tab) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = bureauColors
    var licencesOpen by rememberSaveable { mutableStateOf(false) }
    Column(modifier.fillMaxSize().background(colors.bg)) {
        Column(
            Modifier
                .weight(1f)
                .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
                .verticalScroll(rememberScrollState())
                .padding(bottom = 20.dp),
        ) {
            Text(
                "You",
                Modifier.padding(start = 20.dp, end = 20.dp, top = 6.dp, bottom = 10.dp),
                style = buildUiTextStyle(28.sp, BoldWeight, letterSpacing = (-0.02).em),
                color = colors.ink,
            )
            Group("Controller") {
                SettingRow(BureauIcons.User, state.username, value = { ValueText(readHost(state.controllerUrl)) })
                Hairline(Modifier.padding(start = 56.dp))
                SettingRow(BureauIcons.Connections, "Connection", value = { ConnectionValue(state.connection) })
                Hairline(Modifier.padding(start = 56.dp))
                SettingRow(BureauIcons.Lock, "Sign out", titleColor = colors.failInk, onClick = onSignOut)
            }
            Group("On this phone") {
                if (state.showsOneUiNote) {
                    NoteRow(
                        BureauIcons.Bell,
                        "Show Live Updates",
                        "One UI shows a waiting colleague in the status bar only after you turn on " +
                            "Settings → Developer options → \"Live notifications for all apps\". You do this once.",
                    )
                    Hairline(Modifier.padding(start = 56.dp))
                }
                NoteRow(
                    BureauIcons.Bolt,
                    "Keep alerts arriving",
                    "Add Hercule to \"Never auto sleeping apps\" in the battery settings, so the phone does " +
                        "not stop the live connection while it sleeps.",
                )
            }
            Group("About") {
                SettingRow(
                    BureauIcons.File,
                    "Font licences",
                    value = { ValueText(state.licences.size.toString()) },
                    chevron = if (licencesOpen) BureauIcons.ChevronDown else BureauIcons.ChevronRight,
                    onClick = { licencesOpen = !licencesOpen },
                )
                if (licencesOpen) {
                    state.licences.forEach { licence ->
                        Hairline(Modifier.padding(start = 14.dp))
                        Column(Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(licence.name, style = buildUiTextStyle(15.sp, BoldWeight), color = colors.ink)
                            Text(licence.text, style = buildMonoTextStyle(11.sp, lineHeight = 1.5f), color = colors.muted)
                        }
                    }
                }
            }
        }
        TabBar(Tab.You, state.waitingCount, onSelectTab)
    }
}

/** Draws one group, the book's `.grp`: its [title] over one rounded list of rows. */
@Composable
private fun Group(title: String, rows: @Composable ColumnScope.() -> Unit) {
    val colors = bureauColors
    val shape = RoundedCornerShape(18.dp)
    Column(Modifier.padding(horizontal = 16.dp)) {
        Text(
            title,
            Modifier.padding(start = 6.dp, end = 6.dp, top = 10.dp, bottom = 7.dp),
            style = buildUiTextStyle(12.sp, BoldWeight),
            color = colors.muted,
        )
        Column(
            Modifier
                .fillMaxWidth()
                .background(colors.raised, shape)
                .border(1.dp, colors.lineSoft, shape),
            content = rows,
        )
    }
}

/**
 * Draws one row of a group, the book's `.srow`: [icon] on a sunken square, [title], an optional
 * [value] on the right, and [chevron] when the row opens something ([onClick] is not null).
 */
@Composable
private fun SettingRow(
    icon: ImageVector,
    title: String,
    titleColor: Color = bureauColors.ink,
    value: (@Composable () -> Unit)? = null,
    chevron: ImageVector? = null,
    onClick: (() -> Unit)? = null,
) {
    val colors = bureauColors
    Row(
        Modifier
            .fillMaxWidth()
            // 48 dp, not the book's 46, so that each row is a whole touch target.
            .heightIn(min = 48.dp)
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
            .padding(horizontal = 14.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RowIcon(icon)
        Text(title, Modifier.weight(1f), style = buildUiTextStyle(15.sp), color = titleColor, maxLines = 1, overflow = TextOverflow.Ellipsis)
        value?.invoke()
        if (chevron != null) BureauIcon(chevron, colors.faint, size = 14.dp)
    }
}

/** Draws a row that explains a phone setting: [icon], [title], and the [text] that says what to do. */
@Composable
private fun NoteRow(icon: ImageVector, title: String, text: String) {
    val colors = bureauColors
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        RowIcon(icon)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = buildUiTextStyle(15.sp, lineHeight = 1.4f), color = colors.ink)
            Text(text, style = buildUiTextStyle(13.sp, lineHeight = 1.4f), color = colors.muted)
        }
    }
}

/** Draws a row's icon, the book's `.sic`: a 17 dp line icon on a 30 dp sunken square. */
@Composable
private fun RowIcon(icon: ImageVector) {
    val colors = bureauColors
    Box(Modifier.size(30.dp).background(colors.sunken, RoundedCornerShape(9.dp)), contentAlignment = Alignment.Center) {
        BureauIcon(icon, colors.ink, size = 17.dp)
    }
}

/** Draws a row's value, the book's `.val`, in the muted colour. */
@Composable
private fun ValueText(text: String, color: Color = bureauColors.muted) {
    Text(text, style = buildUiTextStyle(15.sp, MediumWeight), color = color, maxLines = 1, overflow = TextOverflow.Ellipsis)
}

/** Draws where the live connection stands: a dot, green when connected, and the state's words. */
@Composable
private fun ConnectionValue(connection: LiveConnectionState) {
    val colors = bureauColors
    val (words, dot) = when (connection) {
        is LiveConnectionState.Connected -> "Connected" to colors.ok
        LiveConnectionState.Connecting -> "Connecting…" to colors.faint
        LiveConnectionState.Reconnecting -> "Reconnecting…" to colors.fail
        LiveConnectionState.SignedOut -> "Sign in again" to colors.fail
        LiveConnectionState.Stopped -> "Not connected" to colors.faint
    }
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(7.dp).background(dot, CircleShape))
        ValueText(words, if (dot == colors.fail) colors.failInk else colors.muted)
    }
}

/** Returns the host of [url], such as "studio-mac.local:7777" for "http://studio-mac.local:7777/", or [url] when it has none. */
internal fun readHost(url: String): String =
    url.substringAfter("://").substringBefore('/').ifEmpty { url }
