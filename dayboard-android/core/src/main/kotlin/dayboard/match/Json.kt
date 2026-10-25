package dayboard.match

/**
 * A small JSON reader, so the football-data.org parsing runs (and is tested)
 * on the plain JVM: objects become Map<String, Any?>, arrays List<Any?>,
 * numbers Double, plus String, Boolean and null.
 */
object Json {
    class Error(message: String) : IllegalArgumentException(message)

    fun parse(text: String): Any? {
        val r = Reader(text)
        r.ws()
        val v = r.value()
        r.ws()
        if (r.i != text.length) throw Error("Trailing data at ${r.i}")
        return v
    }

    private class Reader(val s: String) {
        var i = 0

        fun ws() { while (i < s.length && s[i] in " \t\r\n") i++ }

        fun value(): Any? {
            if (i >= s.length) throw Error("Unexpected end")
            return when (s[i]) {
                '{' -> obj()
                '[' -> arr()
                '"' -> str()
                't' -> word("true", true)
                'f' -> word("false", false)
                'n' -> word("null", null)
                else -> num()
            }
        }

        fun word(w: String, v: Any?): Any? {
            if (!s.startsWith(w, i)) throw Error("Bad token at $i")
            i += w.length
            return v
        }

        fun obj(): Map<String, Any?> {
            val out = LinkedHashMap<String, Any?>()
            i++; ws()
            if (s.getOrNull(i) == '}') { i++; return out }
            while (true) {
                ws()
                if (s.getOrNull(i) != '"') throw Error("Expected a key at $i")
                val k = str()
                ws()
                if (s.getOrNull(i) != ':') throw Error("Expected : at $i")
                i++; ws()
                out[k] = value()
                ws()
                when (s.getOrNull(i)) {
                    ',' -> i++
                    '}' -> { i++; return out }
                    else -> throw Error("Expected , or } at $i")
                }
            }
        }

        fun arr(): List<Any?> {
            val out = ArrayList<Any?>()
            i++; ws()
            if (s.getOrNull(i) == ']') { i++; return out }
            while (true) {
                ws()
                out += value()
                ws()
                when (s.getOrNull(i)) {
                    ',' -> i++
                    ']' -> { i++; return out }
                    else -> throw Error("Expected , or ] at $i")
                }
            }
        }

        fun str(): String {
            val b = StringBuilder()
            i++
            while (true) {
                if (i >= s.length) throw Error("Unterminated string")
                val c = s[i++]
                when (c) {
                    '"' -> return b.toString()
                    '\\' -> {
                        val e = s.getOrNull(i++) ?: throw Error("Bad escape")
                        when (e) {
                            'n' -> b.append('\n'); 't' -> b.append('\t'); 'r' -> b.append('\r')
                            'b' -> b.append('\b'); 'f' -> b.append('\u000C')
                            'u' -> { b.append(s.substring(i, i + 4).toInt(16).toChar()); i += 4 }
                            else -> b.append(e)
                        }
                    }
                    else -> b.append(c)
                }
            }
        }

        fun num(): Double {
            val start = i
            while (i < s.length && (s[i].isDigit() || s[i] in "+-.eE")) i++
            return s.substring(start, i).toDoubleOrNull() ?: throw Error("Bad number at $start")
        }
    }
}

internal fun Any?.obj(): Map<String, Any?>? = this as? Map<String, Any?>
internal fun Any?.list(): List<Any?> = (this as? List<Any?>) ?: emptyList()
internal fun Map<String, Any?>?.str(k: String): String? = this?.get(k) as? String
internal fun Map<String, Any?>?.int(k: String): Int? = (this?.get(k) as? Double)?.toInt()
internal fun Map<String, Any?>?.long(k: String): Long? = (this?.get(k) as? Double)?.toLong()
