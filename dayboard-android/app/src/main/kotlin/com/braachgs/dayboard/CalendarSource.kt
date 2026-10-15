package com.braachgs.dayboard

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.provider.CalendarContract
import android.provider.CalendarContract.Attendees
import android.provider.CalendarContract.Events
import android.provider.CalendarContract.Instances
import dayboard.core.Event
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset

/** A calendar synced to this phone (every Google account on it, work included). */
data class PhoneCalendar(val id: Long, val name: String, val account: String, val color: Int)

/** Reads the phone's own calendar store: no Google sign-in, no hourly reconnect. */
object CalendarSource {

    fun hasPermission(context: Context): Boolean =
        context.checkSelfPermission(Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED

    /** Calendars shown in the phone's calendar app (the ones ticked there). */
    fun calendars(context: Context): List<PhoneCalendar> {
        if (!hasPermission(context)) return emptyList()
        val out = ArrayList<PhoneCalendar>()
        context.contentResolver.query(
            CalendarContract.Calendars.CONTENT_URI,
            arrayOf(
                CalendarContract.Calendars._ID,
                CalendarContract.Calendars.CALENDAR_DISPLAY_NAME,
                CalendarContract.Calendars.ACCOUNT_NAME,
                CalendarContract.Calendars.CALENDAR_COLOR,
            ),
            "${CalendarContract.Calendars.VISIBLE} = 1",
            null,
            "${CalendarContract.Calendars.ACCOUNT_NAME}, ${CalendarContract.Calendars.CALENDAR_DISPLAY_NAME}",
        )?.use { c ->
            while (c.moveToNext()) {
                out += PhoneCalendar(c.getLong(0), c.getString(1) ?: "", c.getString(2) ?: "", c.getInt(3))
            }
        }
        return out
    }

    /**
     * Event instances from yesterday to the day after tomorrow, wide enough for
     * the board's today-and-tomorrow window in any time zone. Skips calendars
     * hidden in [Settings], cancelled events and invitations you declined.
     */
    fun events(context: Context, now: Long, zone: ZoneId): List<Event> {
        if (!hasPermission(context)) return emptyList()
        val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
        val from = today.minusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()
        val to = today.plusDays(3).atStartOfDay(zone).toInstant().toEpochMilli()
        val uri = Instances.CONTENT_URI.buildUpon().also {
            ContentUris.appendId(it, from)
            ContentUris.appendId(it, to)
        }.build()
        val hidden = Settings.hiddenCalendars(context)
        val out = ArrayList<Event>()
        context.contentResolver.query(
            uri,
            arrayOf(
                Instances.EVENT_ID,
                Instances.CALENDAR_ID,
                Instances.TITLE,
                Instances.EVENT_LOCATION,
                Instances.BEGIN,
                Instances.END,
                Instances.ALL_DAY,
                Instances.DISPLAY_COLOR,
                Instances.STATUS,
                Instances.SELF_ATTENDEE_STATUS,
            ),
            "${Instances.VISIBLE} = 1",
            null,
            "${Instances.BEGIN} ASC",
        )?.use { c ->
            while (c.moveToNext()) {
                val calendarId = c.getLong(1)
                if (calendarId in hidden) continue
                if (!c.isNull(8) && c.getInt(8) == Events.STATUS_CANCELED) continue
                if (!c.isNull(9) && c.getInt(9) == Attendees.ATTENDEE_STATUS_DECLINED) continue
                val allDay = c.getInt(6) == 1
                var begin = c.getLong(4)
                var end = c.getLong(5)
                if (allDay) {
                    // All-day instances are stored as UTC midnights: move them to local midnights.
                    begin = utcMidnightToLocal(begin, zone)
                    end = utcMidnightToLocal(end, zone)
                }
                out += Event(
                    id = c.getLong(0),
                    calendarId = calendarId,
                    title = c.getString(2)?.takeIf { it.isNotBlank() } ?: "(No title)",
                    location = c.getString(3),
                    start = begin,
                    end = maxOf(end, begin),
                    allDay = allDay,
                    color = c.getInt(7) or 0xFF000000.toInt(),
                )
            }
        }
        return out
    }

    private fun utcMidnightToLocal(t: Long, zone: ZoneId): Long =
        Instant.ofEpochMilli(t).atZone(ZoneOffset.UTC).toLocalDate().atStartOfDay(zone).toInstant().toEpochMilli()
}
