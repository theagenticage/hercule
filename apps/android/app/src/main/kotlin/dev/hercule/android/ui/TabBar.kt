package dev.hercule.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.hercule.android.theme.MediumWeight

/** The tabs of the app's tab bar. Only [Office] and [You] have screens yet. */
enum class Tab { Office, You }

/**
 * Draws the book's tab bar, `.tabbar`: Threads, Intake, the new-thread button, Office and You.
 * [selected] is drawn in ink and [onSelect] opens a tab. Threads carries a badge with
 * [waitingCount], how many colleagues wait on the user, when it is above zero.
 *
 * Threads, Intake and the new-thread button have no screens in the app yet. They are drawn
 * faint and do nothing, so the bar keeps the book's shape without offering what the app cannot
 * do. Intake has no badge, because the app reads no Intake data.
 */
@Composable
fun TabBar(selected: Tab, waitingCount: Int, onSelect: (Tab) -> Unit, modifier: Modifier = Modifier) {
    val colors = bureauColors
    Column(modifier.fillMaxWidth().background(colors.glassFillThin)) {
        Hairline()
        Row(
            Modifier
                .fillMaxWidth()
                .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom + WindowInsetsSides.Horizontal))
                .height(56.dp)
                .padding(horizontal = 8.dp)
                .padding(top = 7.dp),
            horizontalArrangement = Arrangement.SpaceAround,
            verticalAlignment = Alignment.Top,
        ) {
            TabButton(BureauIcons.Threads, "Threads", on = false, enabled = false, onClick = {}, badge = waitingCount.takeIf { it > 0 })
            TabButton(BureauIcons.Intake, "Intake", on = false, enabled = false, onClick = {})
            Box(
                Modifier
                    .padding(top = 2.dp)
                    .size(52.dp, 40.dp)
                    .background(colors.btnFill, RoundedCornerShape(14.dp))
                    .border(1.dp, colors.btnRim, RoundedCornerShape(14.dp)),
                contentAlignment = Alignment.Center,
            ) {
                BureauIcon(BureauIcons.Plus, colors.faint, size = 22.dp)
            }
            TabButton(BureauIcons.Office, "Office", on = selected == Tab.Office, enabled = true, onClick = { onSelect(Tab.Office) })
            TabButton(BureauIcons.User, "You", on = selected == Tab.You, enabled = true, onClick = { onSelect(Tab.You) })
        }
    }
}

/**
 * Draws one tab, the book's `.tb`: [icon] over [label], ink when [on] and faint otherwise, with
 * [badge] at the icon's top right when it is not null. The badge stays at full strength on a
 * faint tab, as in the book.
 */
@Composable
private fun TabButton(icon: ImageVector, label: String, on: Boolean, enabled: Boolean, onClick: () -> Unit, badge: Int? = null) {
    val colors = bureauColors
    val color = if (on) colors.ink else colors.faint
    Column(
        Modifier
            .width(64.dp)
            .semantics { selected = on }
            .clickable(enabled = enabled, role = Role.Tab, onClick = onClick),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Box(Modifier.height(26.dp), contentAlignment = Alignment.Center) {
            BureauIcon(icon, color.copy(alpha = if (enabled) 1f else 0.6f), size = 22.dp)
            if (badge != null) {
                // The book's `.tb-badge`: 3 dp above the icon and 10 dp past its right edge, in a
                // 2 dp ring of the page's colour. The ring is the padding, so the offsets grow by 2 dp.
                YouBadge(
                    badge,
                    Modifier
                        .align(Alignment.TopEnd)
                        .offset(x = 12.dp, y = (-5).dp)
                        .background(colors.bg, RoundedCornerShape(11.dp))
                        .padding(2.dp),
                )
            }
        }
        Text(label, style = buildUiTextStyle(10.5.sp, MediumWeight, lineHeight = 1.2f), color = color.copy(alpha = if (enabled) 1f else 0.6f))
    }
}
