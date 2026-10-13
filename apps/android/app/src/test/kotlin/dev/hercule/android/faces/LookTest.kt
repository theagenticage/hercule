package dev.hercule.android.faces

import dev.hercule.android.faces.Accessory.Bowtie
import dev.hercule.android.faces.Accessory.Glasses
import dev.hercule.android.faces.Accessory.Homburg
import dev.hercule.android.faces.Accessory.Monocle
import dev.hercule.android.faces.Accessory.Tache
import dev.hercule.android.faces.Accessory.Watch
import dev.hercule.android.faces.BodyShape.Egg
import dev.hercule.android.faces.BodyShape.Round
import dev.hercule.android.faces.BodyShape.Tall
import dev.hercule.android.faces.BodyShape.Wide
import dev.hercule.android.faces.Headwear.Beret
import dev.hercule.android.faces.Headwear.Cloche
import dev.hercule.android.faces.Headwear.Headset
import dev.hercule.android.faces.Hue.Grape
import dev.hercule.android.faces.Hue.Iris
import dev.hercule.android.faces.Hue.Lime
import dev.hercule.android.faces.Hue.Mint
import dev.hercule.android.faces.Hue.Orchid
import dev.hercule.android.faces.Hue.Peach
import dev.hercule.android.faces.Hue.Sky
import dev.hercule.android.faces.Hue.Teal
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Test

/**
 * The look's known answers, copied case by case from
 * apps/desktop/src/renderer/faces/look.test.ts, plus the extra vectors in
 * docs/research/android/wire.md §D.1.5, which catch a port that hashes with a signed integer or
 * by code point.
 */
class LookTest {
    /** A seed, its hash, its thread look, and the headwear its assistant look adds. */
    private data class Vector(
        val seed: String,
        val hash: UInt,
        val hue: Hue,
        val shape: BodyShape,
        val accessories: List<Accessory>,
        val headwear: Headwear,
    )

    private val vectors = listOf(
        // From look.test.ts, computed with the Bureau book's own `hash` and `lookFor` in crew.js.
        Vector("", 1698511862u, Mint, Wide, listOf(Tache), Cloche),
        Vector("a", 2426549645u, Peach, Egg, listOf(Watch), Cloche),
        Vector("0199a3c2-7b41-7e2a-9c3d-5f1e2a8b4c60", 2687217523u, Lime, Wide, listOf(Tache, Bowtie), Cloche),
        Vector("0199a3c2-7b41-7e2a-9c3d-5f1e2a8b4c61", 2737239707u, Lime, Tall, listOf(Glasses), Cloche),
        Vector("0199a3c4-0d12-7a55-8b10-3e9f7c21d0aa", 301455944u, Iris, Egg, listOf(Bowtie), Beret),
        // The book's cast table gives this name peach, egg and a tache. The app never uses the
        // cast table: every seed is hashed.
        Vector("Fix 3-D Secure checkout for EU cards", 1898525329u, Teal, Tall, listOf(Bowtie), Beret),
        // From wire.md §D.1.5, computed with the desktop's look.ts.
        Vector("Hercule", 2978801663u, Grape, Wide, listOf(Tache, Bowtie), Beret),
        Vector("Triage", 2084797344u, Iris, Round, listOf(Tache), Cloche),
        Vector("Ada", 1100229590u, Mint, Tall, listOf(Tache), Headset),
        Vector("0199a3c2-7b41-7e2a-9c3d-5f1e2a8b4c60:toolu_01ABC", 1116744836u, Sky, Egg, listOf(Monocle), Headset),
        Vector("New thread in webshop", 2234771898u, Orchid, Wide, listOf(Homburg), Cloche),
        Vector("héllo", 2085756404u, Sky, Wide, listOf(Watch), Cloche),
        Vector("日本語", 3389669919u, Grape, Tall, listOf(Bowtie), Cloche),
        Vector("😀", 819814735u, Grape, Egg, listOf(Homburg), Headset),
        Vector("0199b000-0000-7000-8000-000000000000", 4280435797u, Peach, Tall, listOf(Monocle), Headset),
        Vector("0199b000-0000-7000-8000-000000000001", 1893881932u, Sky, Egg, emptyList(), Beret),
    )

    @Test
    fun `hashes each seed to the book's hash`() {
        for (vector in vectors) assertEquals(vector.hash, hashSeed(vector.seed), vector.seed)
    }

    @Test
    fun `gives each seed the book's look`() {
        for (vector in vectors) {
            assertEquals(Look(vector.hue, vector.shape, vector.accessories, null), buildLook(vector.seed), vector.seed)
        }
    }

    @Test
    fun `gives each assistant its headwear in place of a homburg`() {
        for (vector in vectors) {
            assertEquals(
                Look(vector.hue, vector.shape, vector.accessories - Homburg, vector.headwear),
                buildAssistantLook(vector.seed),
                vector.seed,
            )
        }
    }

    @Test
    fun `reaches every hue, shape and wardrobe entry from 1000 session ids`() {
        val ids = buildSessionIds(1000)
        assertTrue(ids.all { UUID_V7.matches(it) })
        val looks = ids.map(::buildLook)
        assertEquals(Hue.entries.toSet(), looks.map { it.hue }.toSet())
        assertEquals(BodyShape.entries.toSet(), looks.map { it.shape }.toSet())
        assertEquals(Wardrobe.toSet(), looks.map { it.accessories }.toSet())
    }

    @Test
    fun `keeps the thread look's hue and shape for an assistant, and drops only a homburg`() {
        for (id in buildSessionIds(1000)) {
            val thread = buildLook(id)
            val assistant = buildAssistantLook(id)
            assertEquals(thread.hue, assistant.hue)
            assertEquals(thread.shape, assistant.shape)
            assertEquals(thread.accessories - Homburg, assistant.accessories)
            assertNotNull(assistant.headwear)
        }
    }

    @Test
    fun `picks the headwear from the hash's bits 12 and up`() {
        for (id in buildSessionIds(1000)) {
            assertEquals(Headwear.entries[((hashSeed(id) shr 12) % 3u).toInt()], buildAssistantLook(id).headwear)
        }
    }

    @Test
    fun `reaches every headwear and a homburg from 1000 ids`() {
        val ids = buildSessionIds(1000)
        assertEquals(Headwear.entries.toSet(), ids.map { buildAssistantLook(it).headwear }.toSet())
        assertTrue(ids.any { Homburg in buildLook(it).accessories })
    }

    @Test
    fun `never gives a thread's look any headwear`() {
        for (id in buildSessionIds(1000)) assertNull(buildLook(id).headwear)
    }

    private companion object {
        /** The controller's id format: a canonical lowercase UUIDv7. */
        val UUID_V7 = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

        /**
         * Returns [count] ids shaped like the controller's session ids, the same ids look.test.ts
         * builds: consecutive milliseconds from a fixed clock, and other bits from a linear
         * congruential generator with a fixed start, so every run checks the same ids.
         */
        fun buildSessionIds(count: Int): List<String> {
            var state = 1u
            fun randomDigit(): Int {
                state = state * 1664525u + 1013904223u
                return (state shr 28).toInt()
            }
            fun randomHex(digits: Int) = (1..digits).joinToString("") { randomDigit().toString(16) }
            val firstMillisecond = 0x0199a3c27b41L
            return (0 until count).map { index ->
                val time = (firstMillisecond + index).toString(16).padStart(12, '0')
                val variant = (8 + randomDigit() % 4).toString(16)
                "${time.take(8)}-${time.drop(8)}-7${randomHex(3)}-$variant${randomHex(3)}-${randomHex(12)}"
            }
        }
    }
}
