package dev.hercule.android.faces

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.captureRoboImage
import dev.hercule.android.theme.BureauColors
import dev.hercule.android.theme.OrientExpressColors
import dev.hercule.android.theme.WhitehavenColors
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Draws the face rows of the desktop's specimen sheet (apps/desktop/src/renderer/specimens/cells.ts),
 * in the light and the dark theme. The goldens are compared by eye with the Bureau book's own
 * drawing of the same cells, side by side in apps/android/screenshots/faces/specimens-compare.png.
 *
 * The layout is the sheet's (specimens/sheet.css): rows of cells, each with 12 dp of padding and
 * its face in the top-left corner. The sheet's two user avatars are left out: the user's avatar
 * is not a face and is not part of this port.
 *
 * The density is 2, as the desktop captures its sheet, so the goldens line up pixel for pixel.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w1000dp-h1000dp-xhdpi")
class FaceSpecimenTest {
    @Test
    fun drawsTheSpecimenSheetInWhitehaven() = captureSheet(WhitehavenColors)

    @Test
    fun drawsTheSpecimenSheetInOrientExpress() = captureSheet(OrientExpressColors)

    private fun captureSheet(colors: BureauColors) = captureRoboImage {
        Column(Modifier.background(colors.bg)) {
            for (row in SHEET) {
                Row {
                    for (cell in row) {
                        Box(Modifier.padding(12.dp)) { Face(cell.look, cell.pose, cell.size, colors) }
                    }
                }
            }
        }
    }

    /** One cell of the sheet: a face with [look] in [pose] at [size]. */
    private data class Cell(val look: Look, val pose: Pose, val size: Dp)

    private companion object {
        val PLAIN = Look(Hue.Iris, BodyShape.Egg, emptyList(), null)
        val TACHE = Look(Hue.Iris, BodyShape.Egg, listOf(Accessory.Tache), null)
        val SEEDS = listOf(
            "0199a3c2-7b41-7e2a-9c3d-5f1e2a8b4c60",
            "0199a3c2-7b41-7e2a-9c3d-5f1e2a8b4c61",
            "0199a3c4-0d12-7a55-8b10-3e9f7c21d0aa",
        )

        /** Returns the cells of every pose of [look] at [size]. */
        fun buildPoseCells(look: Look, size: Dp) = Pose.entries.map { Cell(look, it, size) }

        /** Returns the hue [steps] steps along the wheel, in the hash's order, as cells.ts walks it. */
        fun stepHue(steps: Int) = Hue.entries[steps % Hue.entries.size]

        /** The idle face at 34 of each wardrobe entry in each shape, the hue one step further each cell. */
        val WARDROBE_CELLS = Wardrobe.flatMapIndexed { entry, accessories ->
            BodyShape.entries.mapIndexed { index, shape ->
                Cell(Look(stepHue(entry * 4 + index), shape, accessories, null), Pose.Idle, 34.dp)
            }
        }

        /** Each headwear on each shape, idle at 34, the hue one step further each cell. */
        val HEADWEAR_SHAPE_CELLS = Headwear.entries.flatMapIndexed { entry, headwear ->
            BodyShape.entries.mapIndexed { index, shape ->
                Cell(Look(stepHue(entry * 4 + index), shape, emptyList(), headwear), Pose.Idle, 34.dp)
            }
        }

        /** Each headwear idle at 16, 24 and 48, then waiting and asleep at 24. */
        val HEADWEAR_SIZE_CELLS = listOf(
            Pose.Idle to 16.dp,
            Pose.Idle to 24.dp,
            Pose.Idle to 48.dp,
            Pose.Waiting to 24.dp,
            Pose.Asleep to 24.dp,
        ).flatMap { (pose, size) ->
            Headwear.entries.mapIndexed { index, headwear ->
                Cell(Look(stepHue(index), BodyShape.Egg, emptyList(), headwear), pose, size)
            }
        }

        /** The face rows of the desktop's `SHEET`, row by row. */
        val SHEET = listOf(
            buildPoseCells(PLAIN, 22.dp),
            buildPoseCells(PLAIN, 24.dp),
            buildPoseCells(PLAIN, 30.dp),
            buildPoseCells(PLAIN, 34.dp),
            buildPoseCells(PLAIN, 68.dp),
            WARDROBE_CELLS.take(16),
            WARDROBE_CELLS.drop(16),
            buildPoseCells(TACHE, 22.dp) + buildPoseCells(TACHE, 34.dp),
            SEEDS.map { Cell(buildLook(it), Pose.Idle, 34.dp) } + HEADWEAR_SHAPE_CELLS,
            HEADWEAR_SIZE_CELLS,
        )
    }
}
