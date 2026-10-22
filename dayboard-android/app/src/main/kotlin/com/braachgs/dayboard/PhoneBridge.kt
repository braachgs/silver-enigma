package com.braachgs.dayboard

import android.app.Activity
import android.content.ContentUris
import android.content.ContentValues
import android.content.Intent
import android.provider.CalendarContract
import android.provider.CalendarContract.Calendars
import android.provider.CalendarContract.Events
import android.provider.CalendarContract.Instances
import android.util.Log
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject

/**
 * window.DayBoardPhone for the board in [BoardActivity]: the phone's
 * calendar store (every account synced to the phone) read and written for
 * the web app's js/phone.js. Every call returns JSON text; failures come
 * back as {"error": "..."} rather than exceptions, which WebView can't pass.
 */
class PhoneBridge(private val activity: Activity, private val onLinesSaved: () -> Unit) {
    private val cr get() = activity.contentResolver

    private fun error(e: Throwable): String {
        Log.w("DayBoard", "calendar call failed", e)
        val msg = if (e is SecurityException) "Day Board needs access to your calendar. Allow it and try again."
        else e.message ?: "The calendar store refused that."
        if (e is SecurityException) activity.runOnUiThread { (activity as? BoardActivity)?.askForCalendar() }
        return JSONObject().put("error", msg).toString()
    }

    /** The setup sent over from the browser version, for the board's first run. */
    @JavascriptInterface
    fun importedState(): String = Settings.importedState(activity) ?: ""

    @JavascriptInterface
    fun calendars(): String = try {
        val out = JSONArray()
        cr.query(
            Calendars.CONTENT_URI,
            arrayOf(
                Calendars._ID, Calendars.ACCOUNT_NAME, Calendars.NAME, Calendars.CALENDAR_DISPLAY_NAME,
                Calendars.OWNER_ACCOUNT, "_sync_id", Calendars.CALENDAR_COLOR, Calendars.CALENDAR_ACCESS_LEVEL, Calendars.VISIBLE,
            ),
            "${Calendars.SYNC_EVENTS} = 1", null, null,
        )?.use { c ->
            while (c.moveToNext()) {
                val account = c.getString(1) ?: continue
                out.put(JSONObject().apply {
                    put("id", c.getLong(0))
                    put("account", account)
                    put("name", c.getString(2) ?: JSONObject.NULL)
                    put("displayName", c.getString(3) ?: JSONObject.NULL)
                    put("owner", c.getString(4) ?: JSONObject.NULL)
                    put("syncId", c.getString(5) ?: JSONObject.NULL)
                    put("color", c.getInt(6))
                    put("access", c.getInt(7))
                    put("visible", c.getInt(8) == 1)
                    put("primary", c.getString(4) == account)
                })
            }
        }
        out.toString()
    } catch (e: Exception) {
        error(e)
    }

    /** Event instances overlapping [from, to), all calendars; js/phone.js keeps the ones you switched on. */
    @JavascriptInterface
    fun events(from: Double, to: Double): String = try {
        val uri = Instances.CONTENT_URI.buildUpon().also {
            ContentUris.appendId(it, from.toLong())
            ContentUris.appendId(it, to.toLong())
        }.build()
        class Row(val o: JSONObject, val eventId: Long)
        val rows = ArrayList<Row>()
        cr.query(
            uri,
            arrayOf(
                Instances.EVENT_ID, Instances.CALENDAR_ID, Instances.TITLE, Instances.EVENT_LOCATION, Instances.DESCRIPTION,
                Instances.BEGIN, Instances.END, Instances.ALL_DAY, Instances.STATUS, Instances.SELF_ATTENDEE_STATUS,
                Instances.RRULE, Instances.RDATE, Instances.ORIGINAL_ID,
            ),
            null, null, "${Instances.BEGIN} ASC",
        )?.use { c ->
            while (c.moveToNext()) {
                val id = c.getLong(0)
                rows += Row(JSONObject().apply {
                    put("eventId", id)
                    put("calendarId", c.getLong(1))
                    put("title", c.getString(2) ?: "")
                    put("location", c.getString(3) ?: "")
                    put("description", c.getString(4) ?: "")
                    put("begin", c.getLong(5))
                    put("end", c.getLong(6))
                    put("allDay", c.getInt(7) == 1)
                    put("status", if (c.isNull(8)) 0 else c.getInt(8))
                    put("selfStatus", if (c.isNull(9)) 0 else c.getInt(9))
                    put("repeats", !c.getString(10).isNullOrBlank() || !c.getString(11).isNullOrBlank())
                    put("exception", !c.isNull(12))
                }, id)
            }
        }
        // Google's event ids ("_sync_id") live on the events table.
        val sync = HashMap<Long, String>()
        rows.map { it.eventId }.distinct().chunked(500).forEach { ids ->
            cr.query(Events.CONTENT_URI, arrayOf(Events._ID, "_sync_id"), "${Events._ID} IN (${ids.joinToString(",")})", null, null)?.use { c ->
                while (c.moveToNext()) c.getString(1)?.let { sync[c.getLong(0)] = it }
            }
        }
        val out = JSONArray()
        for (r in rows) out.put(r.o.put("syncId", sync[r.eventId] ?: JSONObject.NULL))
        out.toString()
    } catch (e: Exception) {
        error(e)
    }

    private fun values(d: JSONObject) = ContentValues().apply {
        if (d.has("title")) put(Events.TITLE, d.getString("title"))
        if (d.has("location")) put(Events.EVENT_LOCATION, d.getString("location"))
        if (d.has("description")) put(Events.DESCRIPTION, d.getString("description"))
        if (d.has("start")) {
            put(Events.DTSTART, d.getLong("start"))
            put(Events.DTEND, d.getLong("end"))
            put(Events.ALL_DAY, if (d.optBoolean("allDay")) 1 else 0)
            put(Events.EVENT_TIMEZONE, d.optString("timeZone", "UTC"))
        }
    }

    @JavascriptInterface
    fun insertEvent(json: String): String = try {
        val d = JSONObject(json)
        val v = values(d).apply { put(Events.CALENDAR_ID, d.getLong("calendar")) }
        val uri = cr.insert(Events.CONTENT_URI, v) ?: throw IllegalStateException("The calendar didn't save that event.")
        JSONObject().put("id", ContentUris.parseId(uri)).toString()
    } catch (e: Exception) {
        error(e)
    }

    @JavascriptInterface
    fun updateEvent(id: String, json: String): String = try {
        val n = cr.update(ContentUris.withAppendedId(Events.CONTENT_URI, id.toLong()), values(JSONObject(json)), null, null)
        if (n < 1) throw IllegalStateException("That event is no longer on this phone.")
        "{}"
    } catch (e: Exception) {
        error(e)
    }

    @JavascriptInterface
    fun deleteEvent(id: String): String = try {
        cr.delete(ContentUris.withAppendedId(Events.CONTENT_URI, id.toLong()), null, null)
        "{}"
    } catch (e: Exception) {
        error(e)
    }

    /** Opens the event in the phone's Calendar app (repeating events are edited there). */
    @JavascriptInterface
    fun openEvent(id: String, at: String) {
        val intent = Intent(Intent.ACTION_VIEW, ContentUris.withAppendedId(Events.CONTENT_URI, id.toLongOrNull() ?: return))
            .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, at.toDoubleOrNull()?.toLong() ?: 0L)
        activity.runOnUiThread { runCatching { activity.startActivity(intent) } }
    }

    /** The board's lines, for the widget (the same text "Send lines to widget" carries). */
    @JavascriptInterface
    fun saveLines(text: String) {
        if (Settings.linesText(activity) == text) return
        if (Settings.saveLines(activity, text)) onLinesSaved()
    }

    @JavascriptInterface
    fun openWidgetSettings() {
        activity.runOnUiThread { activity.startActivity(Intent(activity, MainActivity::class.java)) }
    }
}
