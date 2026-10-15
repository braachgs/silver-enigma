package com.braachgs.dayboard

import android.content.Context
import dayboard.core.Flap

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

    fun setCode(context: Context, calendarId: Long, code: String) {
        val clean = Flap.clean(code).replace(" ", "").take(3)
        prefs(context).edit().apply {
            if (clean.isEmpty()) remove("code_$calendarId") else putString("code_$calendarId", clean)
        }.apply()
    }
}
