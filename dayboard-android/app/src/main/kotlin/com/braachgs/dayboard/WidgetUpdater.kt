package com.braachgs.dayboard

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.text.format.DateFormat
import android.widget.RemoteViews
import dayboard.core.BoardBuilder
import dayboard.core.BoardLayout
import dayboard.core.BoardModel
import dayboard.core.BoardRenderer
import dayboard.core.Event
import dayboard.core.Line
import java.time.ZoneId
import java.util.Locale

/** Draws every Day Board widget and arranges the next wake-up. */
object WidgetUpdater {
    const val WEB_APP = "https://braachgs.github.io/silver-enigma/dayboard/"

    @Volatile private var typeface: Typeface? = null

    fun typeface(context: Context): Typeface =
        typeface ?: context.resources.getFont(R.font.barlow_condensed_semibold).also { typeface = it }

    fun widgetIds(context: Context): IntArray =
        AppWidgetManager.getInstance(context).getAppWidgetIds(ComponentName(context, BoardWidget::class.java))

    /** Line tiles: the calendar's code on the event's own colour (its calendar's, unless the event has one). */
    fun lineOf(context: Context): (Event) -> Line {
        val names = CalendarSource.calendars(context).associate { it.id to it.name }
        val codes = HashMap<Long, String>()
        return { e -> Line(codes.getOrPut(e.calendarId) { Settings.code(context, e.calendarId, names[e.calendarId] ?: "") }, e.color) }
    }

    /**
     * Builds the board for a widget of [wDp] x [hDp]. Shared with the app's
     * preview, so what you see in the app is what the widget shows.
     */
    fun render(context: Context, wDp: Float, hDp: Float, now: Long = System.currentTimeMillis(), events: List<Event>? = null, clock: String? = null): Pair<Bitmap, BoardModel> {
        val d = context.resources.displayMetrics.density
        val hour12 = !DateFormat.is24HourFormat(context)
        val zone = ZoneId.systemDefault()
        val layout = BoardLayout(wDp * d, hDp * d, d, hour12)
        val allowed = CalendarSource.hasPermission(context)
        val list = events ?: CalendarSource.events(context, now, zone)
        val model = BoardBuilder(zone, hour12, Locale.getDefault()).build(
            list, lineOf(context), now, layout.capacity,
            message = if (allowed) null else "TAP TO ALLOW CALENDAR ACCESS",
        )
        val bitmap = Bitmap.createBitmap(layout.w.toInt().coerceAtLeast(1), layout.h.toInt().coerceAtLeast(1), Bitmap.Config.ARGB_8888)
        BoardRenderer(cornerRadiusDp(context)).draw(AndroidPainter(Canvas(bitmap), typeface(context)), model, layout, clock)
        return bitmap to model
    }

    /** Android 12+ widgets share the system's corner radius. */
    private fun cornerRadiusDp(context: Context): Float {
        if (Build.VERSION.SDK_INT < 31) return 16f
        val px = context.resources.getDimension(android.R.dimen.system_app_widget_background_radius)
        return px / context.resources.displayMetrics.density
    }

    fun updateAll(context: Context, scheduleContentJob: Boolean = true) {
        val ids = widgetIds(context)
        if (ids.isEmpty()) {
            cancelAlarm(context)
            CalendarChangeJob.cancel(context)
            return
        }
        val mgr = AppWidgetManager.getInstance(context)
        val now = System.currentTimeMillis()
        val events = CalendarSource.events(context, now, ZoneId.systemDefault())
        var next = Long.MAX_VALUE
        for (id in ids) {
            val (wDp, hDp) = sizeDp(mgr, id)
            val (bitmap, model) = render(context, wDp, hDp, now, events)
            val compact = hDp < 190
            val views = RemoteViews(context.packageName, if (compact) R.layout.widget_board_compact else R.layout.widget_board)
            views.setImageViewBitmap(R.id.board, bitmap)
            views.setContentDescription(R.id.board, describe(model))
            views.setOnClickPendingIntent(R.id.widget_root, clickIntent(context))
            mgr.updateAppWidget(id, views)
            next = minOf(next, model.nextChange)
        }
        scheduleAlarm(context, next)
        if (scheduleContentJob) CalendarChangeJob.schedule(context)
    }

    /** Portrait size: Android reports the width as the minimum and the height as the maximum. */
    private fun sizeDp(mgr: AppWidgetManager, id: Int): Pair<Float, Float> {
        val o = mgr.getAppWidgetOptions(id)
        val w = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH)
        val h = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT)
        return if (w > 0 && h > 0) w.toFloat() to h.toFloat() else 250f to 110f
    }

    /** What TalkBack reads for the board. */
    private fun describe(model: BoardModel): String =
        if (model.rows.isEmpty()) "Day Board: ${model.message?.lowercase()}"
        else "Day Board departures: " + model.rows.joinToString("; ") { "${it.time.trim()} ${it.event.title}, ${it.remark.text.lowercase()}" }

    /** Tapping opens Day Board (the installed web app picks up its own link), or this app to grant access. */
    private fun clickIntent(context: Context): PendingIntent {
        val intent = if (CalendarSource.hasPermission(context)) {
            Intent(Intent.ACTION_VIEW, Uri.parse(WEB_APP))
        } else {
            Intent(context, MainActivity::class.java)
        }.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun alarmIntent(context: Context): PendingIntent =
        PendingIntent.getBroadcast(
            context, 0, Intent(context, AlarmReceiver::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

    /**
     * Wakes the board when its next remark changes or at midnight. The alarm
     * doesn't wake a sleeping phone: if the screen is off it runs on the next
     * wake, so the board is current when you look at it.
     */
    private fun scheduleAlarm(context: Context, at: Long) {
        if (at == Long.MAX_VALUE) return
        val am = context.getSystemService(AlarmManager::class.java)
        val t = at + 1_000
        if (Build.VERSION.SDK_INT >= 31 && !am.canScheduleExactAlarms()) {
            am.setAndAllowWhileIdle(AlarmManager.RTC, t, alarmIntent(context))
        } else {
            am.setExactAndAllowWhileIdle(AlarmManager.RTC, t, alarmIntent(context))
        }
    }

    private fun cancelAlarm(context: Context) {
        context.getSystemService(AlarmManager::class.java).cancel(alarmIntent(context))
    }
}
