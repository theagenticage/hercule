package dev.hercule.android.faces

import androidx.compose.ui.unit.dp
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.Test

/**
 * The cases of apps/desktop/src/renderer/faces/face.test.tsx, as checks on the face's geometry
 * and the pose rather than on SVG markup. How the parts look together is checked by the specimen
 * sheet in [FaceSpecimenTest].
 */
class FaceGeometryTest {
    @Test
    fun drawsEachBodyAsTheBureauBookDoes() {
        // The wide body's left edge is 7.800000000000001, not 7.8: crew.js leaves the edges' x
        // unrounded, and 24 - 16.2 is that number in floating point. It is not a bug.
        val bookPaths = mapOf(
            BodyShape.Egg to "M24 9.6C32.64 9.6 38.4 19.63 38.4 30.5C38.4 37.88 34.08 42.4 24 42.4C13.92 42.4 9.6 37.88 9.6 30.5C9.6 19.63 15.36 9.6 24 9.6Z",
            BodyShape.Tall to "M24 8.4C31.68 8.4 36.8 19.25 36.8 31C36.8 38.07 32.96 42.4 24 42.4C15.04 42.4 11.2 38.07 11.2 31C11.2 19.25 16.32 8.4 24 8.4Z",
            BodyShape.Round to "M24 11C33.24 11 39.4 19.88 39.4 29.5C39.4 37.5 34.78 42.4 24 42.4C13.22 42.4 8.6 37.5 8.6 29.5C8.6 19.88 14.76 11 24 11Z",
            BodyShape.Wide to "M24 12.6C33.72 12.6 40.2 21.43 40.2 31C40.2 38.07 35.34 42.4 24 42.4C12.66 42.4 7.800000000000001 38.07 7.800000000000001 31C7.800000000000001 21.43 14.28 12.6 24 12.6Z",
        )
        for ((shape, path) in bookPaths) assertEquals(path, buildBodyPath(shape), shape.name)
    }

    @Test
    fun drawsFacesBelow30DpBoldWithEyes1Point2TimesLarger() {
        // At 29 dp the idle eye's x radius is 2.4 and its glint's radius 0.84; at 30 dp, 2 and 0.7.
        assertTrue(isBold(29.dp))
        assertEquals(2.4, 2 * computeEyeScale(isBold(29.dp)), 1e-9)
        assertEquals(0.84, 0.7 * computeEyeScale(isBold(29.dp)), 1e-9)
        assertFalse(isBold(30.dp))
        assertEquals(2.0, 2 * computeEyeScale(isBold(30.dp)))
        assertEquals(0.7, 0.7 * computeEyeScale(isBold(30.dp)))
    }

    @Test
    fun movesTheMouthFrom32Point6DownTo34Point4UnderATache() {
        assertEquals(32.6, computeMouthY(wearsTache = false))
        assertEquals(34.4, computeMouthY(wearsTache = true))
        // The failed mouth is a wave 0.6 below the mouth's y, the waiting "o" 0.2 below.
        assertEquals("33.2", formatSvgNumber(computeMouthY(wearsTache = false) + 0.6))
        assertEquals("35", formatSvgNumber(computeMouthY(wearsTache = true) + 0.6))
        assertEquals(34.6, computeMouthY(wearsTache = true) + 0.2, 1e-9)
    }

    @Test
    fun hidesEveryMouthButTheWaitingDoneAndFailedOnesUnderATache() {
        for (pose in Pose.entries) {
            assertTrue(showsMouth(pose, wearsTache = false), pose.name)
            assertEquals(pose in setOf(Pose.Waiting, Pose.Done, Pose.Failed), showsMouth(pose, wearsTache = true), pose.name)
        }
    }

    @Test
    fun spellsEachPoseAsTheBookDoes() {
        assertEquals(
            listOf("working", "waiting on you", "idle", "asleep", "failed", "paused", "done", "can't be reached"),
            Pose.entries.map { it.words },
        )
    }
}
