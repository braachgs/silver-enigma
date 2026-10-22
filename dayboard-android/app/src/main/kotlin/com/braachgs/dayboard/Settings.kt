package com.braachgs.dayboard

import android.content.Context
import dayboard.core.Flap
import dayboard.core.LineConfig

/** Which calendars the widget shows, and the three-letter code on each one's line tile. */
object Settings {
    private const val FILE = "settings"
    private const val HIDDEN = "hidden"

    private fun prefs(context: Context) = context.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun hiddenCalendars(context: Context): Set<Long> =
        prefs(context).getStringSet(HIDDEN, emptySet())!!.mapNotNull { it.toLongOrNull() }.toSet()

    fun setShown(context: Context, calendarId: Long, shown: Boolean) {
        val hidden = hiddenCalendars(context).toMutableSet()
        if (shown) hidden -= calendarId else hidden += calendarId
        prefs(context).edit().putStringSet(HIDDEN, hidden.map { it.toString() }.toSet()).apply()
    }

    /** The code you typed for this calendar, else one made from its name (Work -> WRK). */
    fun code(context: Context, calendarId: Long, calendarName: String): String =
        customCode(context, calendarId) ?: Flap.code(calendarName)

    fun customCode(context: Context, calendarId: Long): String? =
        prefs(context).getString("code_$calendarId", null)?.takeIf { it.isNotBlank() }

    /** The lines sent from the Day Board web app (Settings > Android widget), if any. */
    fun lineConfig(context: Context): LineConfig? = LineConfig.parse(prefs(context).getString(LINES, null))

    fun linesSentAt(context: Context): Long = prefs(context).getLong(LINES_AT, 0L)

    fun linesText(context: Context): String? = prefs(context).getString(LINES, null)

    /** The browser version's whole setup (JSON), sent along with its lines: the app's board starts from it. */
    fun importedState(context: Context): String? = prefs(context).getString(STATE, null)

    fun saveImportedState(context: Context, json: String) {
        prefs(context).edit().putString(STATE, json).apply()
    }

    /** Stores [text] if it is a Day Board line setup; false otherwise. */
    fun saveLines(context: Context, text: String?): Boolean {
        if (LineConfig.parse(text) == null) return false
        prefs(context).edit().putString(LINES, text).putLong(LINES_AT, System.currentTimeMillis()).apply()
        return true
    }

    fun clearLines(context: Context) {
        prefs(context).edit().remove(LINES).remove(LINES_AT).apply()
    }

    private const val LINES = "lines"
    private const val LINES_AT = "lines_at"
    private const val STATE = "imported_state"

    fun setCode(context: Context, calendarId: Long, code: String) {
        val clean = Flap.clean(code).replace(" ", "").take(3)
        prefs(context).edit().apply {
            if (clean.isEmpty()) remove("code_$calendarId") else putString("code_$calendarId", clean)
        }.apply()
    }
}
