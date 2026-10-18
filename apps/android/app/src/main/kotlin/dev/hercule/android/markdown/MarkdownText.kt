package dev.hercule.android.markdown

import org.commonmark.internal.util.Html5Entities

/*
 * The text helpers that the markdown parser and its embedded HTML reader share: character
 * references, link and image addresses, and plain text. A port of
 * packages/client-core/src/markdown-text.ts.
 *
 * No regular expression is used here. Android's java.util.regex is built on ICU, which differs
 * from the JVM's engine and from JavaScript's in its character classes and case folding, so each
 * rule is written out over plain characters and behaves the same on the phone, in the JVM tests
 * and in client-core.
 */

/** The character CommonMark uses for a code point that is not a valid character. */
private const val REPLACEMENT_CHARACTER = '\uFFFD'

/**
 * Checks whether a code point written as `&#...;` is a valid character. Control characters,
 * surrogates, noncharacters and code points past U+10FFFF are not, which is the rule of the
 * `micromark` parser behind react-markdown.
 */
private fun isValidCodePoint(codePoint: Int): Boolean =
    !(codePoint < 9 ||
        codePoint == 11 ||
        (codePoint in 14..31) ||
        (codePoint in 127..159) ||
        (codePoint in 0xD800..0xDFFF) ||
        (codePoint in 0xFDD0..0xFDEF) ||
        codePoint % 0x10000 >= 0xFFFE ||
        codePoint > 0x10FFFF)

private fun isAsciiDigit(character: Char): Boolean = character in '0'..'9'

private fun isAsciiHexDigit(character: Char): Boolean =
    character in '0'..'9' || character in 'a'..'f' || character in 'A'..'F'

/** Checks whether [character] is an ASCII letter: A to Z in either case. */
internal fun isAsciiLetter(character: Char): Boolean = character in 'a'..'z' || character in 'A'..'Z'

/** Checks whether [character] is an ASCII letter or digit. */
internal fun isAsciiAlphanumeric(character: Char): Boolean = isAsciiLetter(character) || isAsciiDigit(character)

/**
 * Returns the end of the run of characters from [start] that [accepts] takes, stopping at [limit]
 * characters or at the end of [text].
 */
private inline fun findRunEnd(text: String, start: Int, limit: Int, accepts: (Char) -> Boolean): Int {
    var end = start
    while (end < text.length && end - start < limit && accepts(text[end])) end++
    return end
}

/**
 * Reads the character reference that starts with the `&` at [start], as CommonMark defines one: a
 * decimal one of 1 to 7 digits, a hexadecimal one of 1 to 6 digits, or a name of at most 32
 * letters and digits, then `;`. Appends what it stands for to [out] and returns the index after
 * it, or returns -1 when no reference starts there.
 *
 * A name that does not exist, such as `&foo;`, is appended as written. A number that is not a
 * valid character is appended as U+FFFD.
 */
private fun readCharacterReference(text: String, start: Int, out: StringBuilder): Int {
    val afterAmpersand = start + 1
    if (afterAmpersand >= text.length) return -1
    if (text[afterAmpersand] == '#') {
        val afterHash = afterAmpersand + 1
        val hexadecimal = afterHash < text.length && (text[afterHash] == 'x' || text[afterHash] == 'X')
        val digitsStart = if (hexadecimal) afterHash + 1 else afterHash
        // One more than the longest run, so that a run that is too long is seen as such.
        val digitsEnd =
            if (hexadecimal) findRunEnd(text, digitsStart, 7, ::isAsciiHexDigit)
            else findRunEnd(text, digitsStart, 8, ::isAsciiDigit)
        val digitCount = digitsEnd - digitsStart
        val maxDigits = if (hexadecimal) 6 else 7
        if (digitCount == 0 || digitCount > maxDigits) return -1
        if (digitsEnd >= text.length || text[digitsEnd] != ';') return -1
        val codePoint = text.substring(digitsStart, digitsEnd).toInt(if (hexadecimal) 16 else 10)
        if (isValidCodePoint(codePoint)) out.appendCodePoint(codePoint) else out.append(REPLACEMENT_CHARACTER)
        return digitsEnd + 1
    }
    if (!isAsciiLetter(text[afterAmpersand])) return -1
    val nameEnd = findRunEnd(text, afterAmpersand, 33, ::isAsciiAlphanumeric)
    if (nameEnd - afterAmpersand > 32 || nameEnd >= text.length || text[nameEnd] != ';') return -1
    // The table is commonmark-java's copy of the HTML5 list, the same 2,125 names as the
    // character-entities package behind client-core. It returns a name it does not know as written.
    out.append(Html5Entities.entityToString(text.substring(start, nameEnd + 1)))
    return nameEnd + 1
}

/**
 * Returns [text] with its character references replaced by the characters they stand for, as
 * CommonMark requires: `AT&amp;T` becomes `AT&T`. A name that does not exist, such as `&foo;`,
 * stays as written. A number that is not a valid character becomes U+FFFD. Each reference is
 * decoded once: `&amp;amp;` becomes `&amp;`.
 *
 * A port of `decodeCharacterReferences` in packages/client-core/src/markdown-text.ts.
 */
fun decodeCharacterReferences(text: String): String {
    var ampersand = text.indexOf('&')
    if (ampersand == -1) return text
    val out = StringBuilder(text.length)
    var copied = 0
    while (ampersand != -1) {
        out.append(text, copied, ampersand)
        val end = readCharacterReference(text, ampersand, out)
        if (end == -1) {
            out.append('&')
            copied = ampersand + 1
        } else {
            copied = end
        }
        ampersand = text.indexOf('&', copied)
    }
    out.append(text, copied, text.length)
    return out.toString()
}

/** The characters that [normalizeAddress] leaves as they are, besides ASCII letters and digits. */
private const val ADDRESS_PUNCTUATION_KEPT = "!#$%&'()*+,-./:;=?@_~"

private const val HEX_DIGITS = "0123456789ABCDEF"

/** Appends [codePoint] to [out] percent-encoded as UTF-8, as `encodeURIComponent` does. */
private fun appendPercentEncoded(out: StringBuilder, codePoint: Int) {
    for (byte in String(Character.toChars(codePoint)).toByteArray(Charsets.UTF_8)) {
        val value = byte.toInt() and 0xFF
        out.append('%').append(HEX_DIGITS[value shr 4]).append(HEX_DIGITS[value and 0xF])
    }
}

/**
 * Returns [address] with every character that a URL should not hold percent-encoded, the way
 * `micromark-util-sanitize-uri` does for react-markdown. A `%` that starts a percent-escape (two
 * letters or digits after it) is kept, so an address that is already encoded is not encoded twice.
 * A lone surrogate becomes U+FFFD.
 *
 * A port of `normalizeAddress` in packages/client-core/src/markdown-text.ts.
 */
fun normalizeAddress(address: String): String {
    val out = StringBuilder(address.length)
    var index = 0
    while (index < address.length) {
        val character = address[index]
        when {
            character == '%' -> {
                val startsEscape =
                    index + 2 < address.length &&
                        isAsciiAlphanumeric(address[index + 1]) &&
                        isAsciiAlphanumeric(address[index + 2])
                out.append(if (startsEscape) "%" else "%25")
                index++
            }
            character.code < 128 && (isAsciiAlphanumeric(character) || character in ADDRESS_PUNCTUATION_KEPT) -> {
                out.append(character)
                index++
            }
            Character.isHighSurrogate(character) && index + 1 < address.length && Character.isLowSurrogate(address[index + 1]) -> {
                appendPercentEncoded(out, Character.toCodePoint(character, address[index + 1]))
                index += 2
            }
            Character.isSurrogate(character) -> {
                appendPercentEncoded(out, REPLACEMENT_CHARACTER.code)
                index++
            }
            else -> {
                appendPercentEncoded(out, character.code)
                index++
            }
        }
    }
    return out.toString()
}

/** The schemes a link or an image may have besides none, the same list react-markdown allows. */
private val SAFE_SCHEMES = listOf("http", "https", "irc", "ircs", "mailto", "xmpp")

/**
 * Returns [text] with ASCII capitals made small, and every other character unchanged. Unicode
 * case mapping would let the Kelvin sign pass for `k`, which a JavaScript pattern with the `i`
 * flag does not.
 */
private fun lowercaseAscii(text: String): String =
    buildString(text.length) { for (character in text) append(if (character in 'A'..'Z') character + 32 else character) }

/**
 * Checks whether a link or image address is safe to draw. It is safe when it has no scheme (a
 * relative address, a `?` or a `#` link) or when its scheme is `http`, `https`, `irc`, `ircs`,
 * `mailto` or `xmpp`, in any case. Any other scheme, such as `javascript:`, is unsafe. Call it with
 * the decoded and normalized address, so that `javascript&#58;alert(1)` is caught.
 *
 * A port of `isSafeAddress` in packages/client-core/src/markdown-text.ts.
 */
fun isSafeAddress(address: String): Boolean {
    val colon = address.indexOf(':')
    if (colon == -1) return true
    val endsOfPath = intArrayOf(address.indexOf('/'), address.indexOf('?'), address.indexOf('#'))
    return endsOfPath.any { end -> end != -1 && colon > end } || lowercaseAscii(address.substring(0, colon)) in SAFE_SCHEMES
}

/**
 * Returns [text] without the line breaks at its end.
 *
 * A port of `trimTrailingNewlines` in packages/client-core/src/markdown-text.ts.
 */
fun trimTrailingNewlines(text: String): String {
    var end = text.length
    while (end > 0 && text[end - 1] == '\n') end--
    return text.substring(0, end)
}

/**
 * Returns the text that [inlines] show, without their markup. It is an image's alt text. A line
 * break is [breakText], which is empty unless given.
 *
 * A port of `extractPlainText` in packages/client-core/src/markdown-text.ts.
 */
fun extractPlainText(inlines: List<MarkdownInline>, breakText: String = ""): String =
    buildString { appendPlainText(inlines, breakText, this) }

private fun appendPlainText(inlines: List<MarkdownInline>, breakText: String, out: StringBuilder) {
    for (inline in inlines) {
        when (inline) {
            is MarkdownInline.Text -> out.append(inline.text)
            is MarkdownInline.InlineCode -> out.append(inline.text)
            is MarkdownInline.Image -> out.append(inline.alt)
            is MarkdownInline.Strong -> appendPlainText(inline.children, breakText, out)
            is MarkdownInline.Emphasis -> appendPlainText(inline.children, breakText, out)
            is MarkdownInline.Strikethrough -> appendPlainText(inline.children, breakText, out)
            is MarkdownInline.Link -> appendPlainText(inline.children, breakText, out)
            MarkdownInline.Break -> out.append(breakText)
            is MarkdownInline.Checkbox,
            is MarkdownInline.FootnoteReference,
            is MarkdownInline.FootnoteBackReference -> Unit
        }
    }
}

/**
 * Returns [inlines] with each link in them replaced by its children, as a link holds no link.
 *
 * A port of `removeNestedLinks` in packages/client-core/src/markdown-text.ts.
 */
fun removeNestedLinks(inlines: List<MarkdownInline>): List<MarkdownInline> =
    inlines.flatMap { inline ->
        when (inline) {
            is MarkdownInline.Link -> removeNestedLinks(inline.children)
            is MarkdownInline.Strong -> listOf(MarkdownInline.Strong(removeNestedLinks(inline.children)))
            is MarkdownInline.Emphasis -> listOf(MarkdownInline.Emphasis(removeNestedLinks(inline.children)))
            is MarkdownInline.Strikethrough -> listOf(MarkdownInline.Strikethrough(removeNestedLinks(inline.children)))
            else -> listOf(inline)
        }
    }
