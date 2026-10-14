package dev.hercule.android.faces

// A port of apps/desktop/src/renderer/faces/look.ts. Every enum lists its entries in the order
// the hash picks them, which is the desktop's order and not the order of tokens.css.

/** The eight hues of the crew wheel, in the order the hash picks them. */
enum class Hue { Iris, Teal, Orchid, Lime, Sky, Peach, Mint, Grape }

/** The four body shapes, in the order the hash picks them. */
enum class BodyShape { Egg, Tall, Round, Wide }

/** One small thing a colleague wears: a hat, a moustache, glasses, a tie or a watch. */
enum class Accessory { Homburg, Bowtie, Tache, Monocle, Watch, Glasses }

/** The headwear an assistant wears, in the order the hash picks it. Threads never wear any. */
enum class Headwear { Cloche, Beret, Headset }

/**
 * What a colleague looks like: its hue, its body shape, and what it wears, in drawing order.
 * [headwear] is the assistant's headwear, drawn over everything else, or null for a thread.
 */
data class Look(
    val hue: Hue,
    val shape: BodyShape,
    val accessories: List<Accessory>,
    val headwear: Headwear?,
)

/**
 * The eight sets of accessories a colleague can wear, in the order the hash picks them. Each set
 * is in drawing order, so "tache, bowtie" draws the tache first.
 */
val Wardrobe: List<List<Accessory>> = listOf(
    emptyList(),
    listOf(Accessory.Homburg),
    listOf(Accessory.Bowtie),
    listOf(Accessory.Tache),
    listOf(Accessory.Monocle),
    listOf(Accessory.Watch),
    listOf(Accessory.Glasses),
    listOf(Accessory.Tache, Accessory.Bowtie),
)

/**
 * Hashes [text] to an unsigned 32-bit integer: FNV-1a over the UTF-16 code units, then a final
 * mix so that seeds differing in one character spread over every hue. It returns the same value
 * as `hashSeed` in the desktop's look.ts and `hash` in the Bureau book's crew.js.
 *
 * The arithmetic is on [UInt] so that it wraps and shifts exactly as JavaScript's `Math.imul`
 * and `>>>` do. A Kotlin [Char] is one UTF-16 code unit, as `charCodeAt` reads it.
 */
fun hashSeed(text: String): UInt {
    var h = 0x811C9DC5u
    for (char in text) {
        h = h xor char.code.toUInt()
        h *= 0x01000193u
    }
    h = h xor (h shr 13)
    h *= 0x85EBCA6Bu
    h = h xor (h shr 16)
    return h
}

/**
 * Returns the look [seed] always gets: the hash's low 3 bits pick the hue, bits 4-5 the shape,
 * bits 8-10 the wardrobe entry. A thread's seed is its session id, exactly as the API returns it;
 * never a name or a title.
 */
fun buildLook(seed: String): Look {
    val h = hashSeed(seed)
    return Look(
        hue = Hue.entries[(h % 8u).toInt()],
        shape = BodyShape.entries[((h shr 4) % 4u).toInt()],
        accessories = Wardrobe[((h shr 8) % 8u).toInt()],
        headwear = null,
    )
}

/**
 * Returns the look of the assistant with id [assistantId]: the look [buildLook] gives the id,
 * wearing the headwear that the hash's bits 12 and up pick, modulo 3. One head wears one hat, so
 * the headwear replaces a homburg.
 */
fun buildAssistantLook(assistantId: String): Look {
    val look = buildLook(assistantId)
    val headwear = Headwear.entries[((hashSeed(assistantId) shr 12) % Headwear.entries.size.toUInt()).toInt()]
    return look.copy(accessories = look.accessories - Accessory.Homburg, headwear = headwear)
}
