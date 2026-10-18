package dev.hercule.android.markdown

/*
 * Reads the plain text of a line of markdown, the stretch between two of its elements, the way
 * marked 18's inline lexer reads it with GitHub-flavoured markdown on: escapes, line breaks, bare
 * URLs and email addresses, and text. client-core parses with marked, so the text, the breaks and
 * the bare links come out as they do there. A port of marked's `escape`, `br`, `url`,
 * `_backpedal` and `text` rules (marked/src/rules.ts, `inlineGfm` and `inlineBreaks`) and of the
 * `url` and `inlineText` tokenizers (marked/src/Tokenizer.ts), and of how client-core's
 * `mapInline` in packages/client-core/src/markdown.ts turns their tokens into nodes.
 *
 * Every rule is written out as code over plain characters rather than as a regular expression.
 * Android's java.util.regex is ICU's, whose `\s`, `\w`, `\b`, `$` and case folding differ from
 * the JVM's and from JavaScript's, and nested repetition in it can overflow the stack on a long
 * line. JavaScript's `\s` is [isJavaScriptWhitespace], and its `\w` is ASCII letters, digits and
 * `_`.
 */

/** Checks whether [character] is ASCII punctuation, which a backslash escapes. */
private fun isAsciiPunctuation(character: Char): Boolean = character in "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"

/** Checks whether [character] may appear in the address part of an email that marked's text rule looks ahead for. */
private fun isEmailLookaheadCharacter(character: Char): Boolean = isAsciiAlphanumeric(character) || character in ".!#$%&'*+/=?_`{|}~-"

/** Checks whether [character] may appear before the `@` of an email that marked links. */
private fun isEmailLocalCharacter(character: Char): Boolean = isAsciiAlphanumeric(character) || character in "._+-"

/** Checks whether [character] may appear in a label of an email's domain: a letter, a digit, `-` or `_`. */
private fun isEmailDomainCharacter(character: Char): Boolean = isAsciiAlphanumeric(character) || character == '-' || character == '_'

/** Checks whether [character] is a word character as JavaScript's `\w` reads one, or `-`. */
private fun isWordCharacterOrHyphen(character: Char): Boolean = isAsciiAlphanumeric(character) || character == '_' || character == '-'

/** Checks whether [character] ends a run of text where marked tries its other rules: `\`, `<`, `!`, `[`, a backtick, `*`, `~` or `_`. */
private fun isTextStop(character: Char): Boolean = character in "\\<![`*~_"

/**
 * Returns the length of the scheme and `://` of a URL at [index] in [text], for `http`, `https`
 * or `ftp` in any case, or 0 when none is there.
 */
private fun matchProtocol(text: String, index: Int): Int {
    fun isAt(offset: Int, lower: Char) = index + offset < text.length && (text[index + offset] == lower || text[index + offset] == lower - 32)
    val schemeLength =
        when {
            isAt(0, 'h') && isAt(1, 't') && isAt(2, 't') && isAt(3, 'p') -> if (isAt(4, 's')) 5 else 4
            isAt(0, 'f') && isAt(1, 't') && isAt(2, 'p') -> 3
            else -> return 0
        }
    return if (text.startsWith("://", index + schemeLength)) schemeLength + 3 else 0
}

/**
 * Returns the end of the domain of an email whose `@` is just before [start], reading no further
 * than [limit], or -1 when none is there. The domain is labels of letters, digits, `-` and `_`
 * joined by single dots, at least two of them, and it ends in a letter or a digit that no letter,
 * digit, `_` or `-` follows. Of the ends that are valid, the last one is taken, as marked's greedy
 * pattern takes it.
 */
private fun matchEmailDomain(text: String, start: Int, limit: Int): Int {
    var end = start
    while (end < limit && (isEmailDomainCharacter(text[end]) || text[end] == '.')) end++
    var best = -1
    var seenDot = false
    var position = start
    while (position < end) {
        val character = text[position]
        if (character == '.') {
            // A label may not be empty: not first, and not after another dot.
            if (position == start || text[position - 1] == '.') break
            seenDot = true
        } else if (seenDot && isAsciiAlphanumeric(character)) {
            val next = position + 1
            if (next >= limit || !isWordCharacterOrHyphen(text[next])) best = next
        }
        position++
    }
    return best
}

/**
 * Returns the end of an email that starts at [start] in [text], reading no further than [limit]:
 * letters, digits, `.`, `_`, `+` or `-`, then `@` and a domain as [matchEmailDomain] reads it.
 * Returns -1 when none starts there.
 */
private fun matchEmail(text: String, start: Int, limit: Int, runs: TextRuns): Int {
    val at = minOf(runs.emailLocal.findEnd(start), limit)
    if (at == start || at >= limit || text[at] != '@') return -1
    return matchEmailDomain(text, at + 1, limit)
}

/**
 * Returns [url] with the punctuation at its end that is not part of it removed, as marked's
 * `_backpedal` does once: `.` and `,` before a space, a `)` without its `(`, and an `&` that does
 * not start a character reference at the very end. It keeps a pair of parentheses and the
 * punctuation in the middle of the URL.
 */
private fun backpedalOnce(url: String): String {
    var position = 0
    while (position < url.length) {
        val character = url[position]
        when {
            character !in "?!.,:;*_'\"~()&" -> {
                while (position < url.length && url[position] !in "?!.,:;*_'\"~()&") position++
            }
            character == '(' -> {
                val close = url.indexOf(')', position + 1)
                if (close == -1) return url.substring(0, position)
                position = close + 1
            }
            character == '&' -> {
                // An `&` stays, unless it starts what reads as a character reference at the very end.
                var nameEnd = position + 1
                while (nameEnd < url.length && isAsciiAlphanumeric(url[nameEnd])) nameEnd++
                val endsWithReference = nameEnd > position + 1 && nameEnd == url.length - 1 && url[nameEnd] == ';'
                if (endsWithReference) return url.substring(0, position)
                position++
            }
            character == ')' || character in "?!.,:;*_'\"~" -> {
                var runEnd = position
                while (runEnd < url.length && url[runEnd] in "?!.,:;*_'\"~)") runEnd++
                // The run may not reach the end of the URL: the last character of such a run is dropped.
                val kept = if (runEnd == url.length) runEnd - 1 else runEnd
                if (kept <= position) return url.substring(0, position)
                position = kept
                if (kept < runEnd) return url.substring(0, kept)
            }
        }
    }
    return url
}

/** Returns [url] with [backpedalOnce] applied until nothing more is removed, as marked's `url` tokenizer loops. */
private fun backpedal(url: String): String {
    var current = url
    while (true) {
        val next = backpedalOnce(current)
        if (next == current) return current
        current = next
    }
}

/** A bare URL or email that marked turns into a link: the source it covers, its address and its text. */
private class BareLink(val end: Int, val href: String, val text: String)

/**
 * Reads a bare URL or email at [start] in [text], as marked's GFM `url` rule and tokenizer read
 * one, without reading past [end]. Returns null when none starts there.
 *
 * - `mailto:` or `xmpp:` and an email, with a `/resource` after an `xmpp:` one.
 * - `http://`, `https://`, `ftp://` in any case, or `www.`, then a letter, digit or `-`, and
 *   everything up to the next white space or `<`.
 * - An email, which links to `mailto:` and the email.
 *
 * Trailing punctuation is removed from all but a plain email, see [backpedal].
 */
private fun readBareLink(text: String, start: Int, end: Int, runs: TextRuns): BareLink? {
    val protocolLength =
        when {
            end - start >= 7 && text.startsWith("mailto:", start) -> 7
            end - start >= 5 && text.startsWith("xmpp:", start) -> 5
            else -> 0
        }
    if (protocolLength > 0) {
        var emailEnd = matchEmail(text, start + protocolLength, end, runs)
        if (emailEnd != -1) {
            if (protocolLength == 5 && emailEnd < end && text[emailEnd] == '/') {
                var resourceEnd = emailEnd + 1
                while (resourceEnd < end && (isAsciiAlphanumeric(text[resourceEnd]) || text[resourceEnd] == '@' || text[resourceEnd] == '.')) resourceEnd++
                if (resourceEnd > emailEnd + 1) emailEnd = resourceEnd
            }
            val linkText = backpedal(text.substring(start, emailEnd))
            return BareLink(start + linkText.length, linkText, linkText)
        }
    }
    val schemeLength = matchProtocol(text, start)
    val prefixLength = if (schemeLength > 0) schemeLength else if (text.startsWith("www.", start)) 4 else 0
    if (prefixLength > 0 && start + prefixLength < end) {
        val hostStart = start + prefixLength
        if (isAsciiAlphanumeric(text[hostStart]) || text[hostStart] == '-') {
            var urlEnd = hostStart
            while (urlEnd < end && !isJavaScriptWhitespace(text[urlEnd]) && text[urlEnd] != '<') urlEnd++
            val linkText = backpedal(text.substring(start, urlEnd))
            val href = if (schemeLength == 0) "http://$linkText" else linkText
            return BareLink(start + linkText.length, href, linkText)
        }
    }
    val emailEnd = matchEmail(text, start, end, runs)
    if (emailEnd != -1) {
        val linkText = text.substring(start, emailEnd)
        return BareLink(emailEnd, "mailto:$linkText", linkText)
    }
    return null
}

/**
 * Remembers where the run of characters that [accepts] takes from an index ends, so that asking
 * at every character of a long run reads the run once. marked's own patterns read such a run
 * again from every character, which takes quadratic time on a long run.
 */
private class RunEnds(private val text: String, private val limit: Int, private val accepts: (Char) -> Boolean) {
    private var runStart = -1
    private var runEnd = -1

    /** Returns the index after the run that starts at [index], which is [index] when [accepts] takes no character there. */
    fun findEnd(index: Int): Int {
        if (index in (runStart + 1)..runEnd) return runEnd
        var end = index
        while (end < limit && accepts(text[end])) end++
        runStart = index
        runEnd = end
        return end
    }
}

/** The runs that the rules for plain text look ahead over, each read once: spaces, and the two kinds of email characters. */
private class TextRuns(private val text: String, val limit: Int) {
    val spaces = RunEnds(text, limit) { it == ' ' }
    val emailLocal = RunEnds(text, limit, ::isEmailLocalCharacter)
    private val emailLookahead = RunEnds(text, limit, ::isEmailLookaheadCharacter)

    /** Checks whether at least [minimum] spaces and then a line break start at [index]. */
    fun startsBreak(index: Int, minimum: Int): Boolean {
        val end = spaces.findEnd(index)
        return end - index >= minimum && end < limit && text[end] == '\n'
    }

    /** Checks whether a run of [isEmailLookaheadCharacter] starts at [index] and is followed by `@`. */
    fun startsEmailLookahead(index: Int): Boolean {
        val end = emailLookahead.findEnd(index)
        return end > index && end < limit && text[end] == '@'
    }
}

/** Checks whether [prefix] starts at [index] in [text] and ends by [limit]. */
private fun startsWithin(text: String, prefix: String, index: Int, limit: Int): Boolean =
    index + prefix.length <= limit && text.startsWith(prefix, index)

/** Checks whether `mailto:` or `xmpp:` starts at [index] in [text] and ends by [limit]. */
private fun startsEmailProtocol(text: String, index: Int, limit: Int): Boolean =
    startsWithin(text, "mailto:", index, limit) || startsWithin(text, "xmpp:", index, limit)

/** Checks whether a URL's scheme and `://`, or `www.`, start at [index] in [text] and end by [limit]. */
private fun startsUrl(text: String, index: Int, limit: Int): Boolean {
    val schemeLength = matchProtocol(text, index)
    return (schemeLength > 0 && index + schemeLength <= limit) || startsWithin(text, "www.", index, limit)
}

/**
 * Returns the end of the text token that marked's GFM `text` rule reads at [start]: the first
 * character, a run of backticks or a run of tildes, then everything up to where another rule may
 * start. That is before `\`, `<`, `!`, `[`, a backtick, `*`, `~` or `_`, before `http://`,
 * `https://`, `ftp://` or `www.`, before the spaces of a line break, and before an email.
 */
private fun findTextEnd(text: String, start: Int, breaks: Boolean, runs: TextRuns): Int {
    val limit = runs.limit
    val breakSpaces = if (breaks) 0 else 2
    val first = text[start]
    if (!isAsciiAlphanumeric(first) && startsEmailProtocol(text, start + 1, limit)) return start + 1
    var position = start + 1
    if (first == '`' || first == '~') while (position < limit && text[position] == first) position++
    if (position < limit && (text[position] == '`' || text[position] == '~')) return position
    if (runs.startsBreak(position, breakSpaces)) return position
    if (runs.startsEmailLookahead(position)) return position
    while (position < limit) {
        val character = text[position]
        if (isTextStop(character) || startsUrl(text, position, limit)) return position
        if (breaks && runs.startsBreak(position, 0)) return position
        if (character != ' ' && runs.startsBreak(position + 1, breakSpaces)) return position + 1
        if (!isAsciiAlphanumeric(character) && startsEmailProtocol(text, position + 1, limit)) return position + 1
        if (!isEmailLookaheadCharacter(character) && runs.startsEmailLookahead(position + 1)) return position + 1
        position++
    }
    return position
}

/**
 * Returns the end of the line break that marked's `br` rule reads at [start], or -1 when none is
 * there: two or more spaces or a backslash, then a line break, then the spaces and tabs that
 * start the next line. With [breaks], any number of spaces before a line break make one. A line
 * break before nothing but white space is no break.
 */
private fun findBreakEnd(text: String, start: Int, breaks: Boolean, runs: TextRuns): Int {
    val limit = runs.limit
    val lineBreak =
        when {
            text[start] == '\\' -> start + 1
            text[start] == ' ' || (breaks && text[start] == '\n') -> runs.spaces.findEnd(start).takeIf { breaks || it - start >= 2 } ?: return -1
            else -> return -1
        }
    if (lineBreak >= limit || text[lineBreak] != '\n') return -1
    var next = lineBreak + 1
    if ((next until limit).all { isJavaScriptWhitespace(text[it]) }) return -1
    while (next < limit && (text[next] == ' ' || text[next] == '\t')) next++
    return next
}

/**
 * Returns the nodes for the plain text between two elements of a line of markdown: [text] from
 * [start] to [end], which holds only text, escapes, character references and line breaks.
 * [sourceEnd] is where the inline source that holds it ends, which marked's rules look ahead to:
 * the end of the paragraph, or of the emphasis or link text around it.
 *
 * - A footnote reference, `[^label]`, is the node [referenceFootnote] returns for its label. When
 *   that is null, as for a footnote the message does not define, the brackets are text.
 * - An escape is the character it escapes, as a text of its own.
 * - Text is decoded once, for each run between two escapes, breaks or links.
 * - A line break is a break where marked's `br` rule reads one, see [findBreakEnd]. Any other line
 *   break stays in the text.
 * - With [linksBareUrls], a bare URL or email becomes a link when its address is safe, and its
 *   text when not, see [readBareLink]. It is off inside a link, where marked reads none.
 */
internal fun mapPlainText(
    text: String,
    start: Int,
    end: Int,
    sourceEnd: Int,
    breaks: Boolean,
    linksBareUrls: Boolean,
    referenceFootnote: (label: String) -> MarkdownInline?,
): List<MarkdownInline> = readPlainText(text, start, end, end, sourceEnd, breaks, linksBareUrls, referenceFootnote).nodes

/** The nodes for a stretch of plain text, and the index where they end, which a bare URL may move past the stretch. */
internal class PlainText(val nodes: List<MarkdownInline>, val end: Int)

/**
 * Returns the nodes for the plain text of [text] from [start] to [end], as [mapPlainText] does,
 * except that a bare URL that starts in it may run on to [urlEnd], over the elements that follow.
 * marked reads a bare URL up to white space or `<`, before it reads any element in it, so
 * `https://e.com/a~b~` is one link in marked, where commonmark-java reads a strikethrough. The
 * result says where the nodes end.
 */
internal fun readPlainText(
    text: String,
    start: Int,
    end: Int,
    urlEnd: Int,
    sourceEnd: Int,
    breaks: Boolean,
    linksBareUrls: Boolean,
    referenceFootnote: (label: String) -> MarkdownInline?,
): PlainText {
    if (start >= end) return PlainText(emptyList(), start)
    val nodes = ArrayList<MarkdownInline>()
    val runs = TextRuns(text, sourceEnd)
    var textStart = -1
    fun endText(at: Int) {
        if (textStart != -1) nodes.add(MarkdownInline.Text(decodeCharacterReferences(text.substring(textStart, at))))
        textStart = -1
    }
    var position = start
    while (position < end) {
        // client-core's footnote extension reads a reference before marked's own rules.
        val footnote = if (text[position] == '[') readFootnoteReference(text, position, end) else null
        val reference = footnote?.let { referenceFootnote(it.label) }
        if (footnote != null && reference != null) {
            endText(position)
            nodes.add(reference)
            position = footnote.end
            continue
        }
        if (text[position] == '\\' && position + 1 < end && isAsciiPunctuation(text[position + 1])) {
            endText(position)
            nodes.add(MarkdownInline.Text(text[position + 1].toString()))
            position += 2
            continue
        }
        val breakEnd = findBreakEnd(text, position, breaks, runs)
        if (breakEnd != -1 && breakEnd <= end) {
            endText(position)
            nodes.add(MarkdownInline.Break)
            position = breakEnd
            continue
        }
        val link = if (linksBareUrls) readBareLink(text, position, urlEnd, runs) else null
        if (link != null) {
            endText(position)
            // The address and text of a bare URL are literal: no character references.
            val href = normalizeAddress(link.href)
            val children = listOf(MarkdownInline.Text(link.text))
            if (isSafeAddress(href)) nodes.add(MarkdownInline.Link(href, null, children)) else nodes.addAll(children)
            position = link.end
            continue
        }
        if (textStart == -1) textStart = position
        position = minOf(findTextEnd(text, position, breaks, runs), end)
    }
    endText(minOf(position, end))
    return PlainText(nodes, maxOf(position, end))
}
