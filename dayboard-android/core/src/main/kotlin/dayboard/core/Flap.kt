package dayboard.core

import java.text.Normalizer
import kotlin.math.ceil
import kotlin.math.max

/** Text rules for split-flap cells, matching the web app's js/flap.js. */
object Flap {
    // Characters a flap drum can show; anything else becomes a blank flap.
    private val allowed = Regex("[A-Z0-9 .,:;'&\\-/()!?#+@%…]")
    private val marks = Regex("[\\u0300-\\u036f]")

    fun clean(s: String?): String {
        val t = Normalizer.normalize(s ?: "", Normalizer.Form.NFD).replace(marks, "")
            .uppercase()
            .replace(Regex("[‘’`]"), "'")
            .replace(Regex("[–—]"), "-")
            .replace(Regex("\\s+"), " ")
        return buildString { for (c in t) append(if (allowed.matches(c.toString())) c else ' ') }
    }

    /** One line that fits [width] cells, ending in "…" when cut. */
    fun fit(s: String?, width: Int): String {
        val t = clean(s).trim()
        return if (t.length <= width) t else t.take(max(0, width - 1)).trimEnd() + "…"
    }

    /** False when flap cells would lose most of the text (non-Latin scripts, emoji). */
    fun legible(s: String?): Boolean {
        val visible = (s ?: "").replace(Regex("\\s+"), "")
        if (visible.isEmpty()) return true
        val kept = clean(s).replace(Regex("[\\s…]"), "").length
        return kept >= ceil(visible.length / 2.0).toInt()
    }

    /**
     * A three-letter line code from a calendar name, as js/systems.js flapCode:
     * the first letter, then consonants, then the skipped letters, each kept in
     * its own position so nothing repeats (Work -> WRK, Family -> FML, Bob -> BOB).
     */
    fun code(name: String?): String {
        val letters = Normalizer.normalize(name ?: "", Normalizer.Form.NFD).replace(marks, "")
            .uppercase().replace(Regex("[^A-Z0-9]"), "")
        if (letters.isEmpty()) {
            // Non-Latin names: their own first characters, so lines stay distinct.
            val raw = (name ?: "").replace(Regex("\\s+"), "")
            val cps = raw.codePoints().limit(3).toArray()
            return String(cps, 0, cps.size).uppercase().ifEmpty { "LN" }
        }
        val picked = mutableListOf(0)
        for (i in 1 until letters.length) {
            if (picked.size >= 3) break
            if (letters[i] !in "AEIOU") picked += i
        }
        for (i in 1 until letters.length) {
            if (picked.size >= 3) break
            if (i !in picked) picked += i
        }
        return picked.sorted().map { letters[it] }.joinToString("")
    }
}
