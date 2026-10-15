package com.braachgs.dayboard

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.provider.CalendarContract
import android.util.Log
import java.util.concurrent.Executors

internal val worker = Executors.newSingleThreadExecutor()

internal fun updateSafely(app: Context, scheduleContentJob: Boolean = true) {
    try {
        WidgetUpdater.updateAll(app, scheduleContentJob)
    } catch (e: Exception) {
        Log.e("DayBoard", "widget update failed", e)
    }
}

/** Redraws off the main thread, keeping the receiver alive until it's done. */
internal fun BroadcastReceiver.updateWidgetsAsync(context: Context) {
    val pending = goAsync()
    val app = context.applicationContext
    worker.execute {
        try {
            WidgetUpdater.updateAll(app)
        } catch (e: Exception) {
            Log.e("DayBoard", "widget update failed", e)
        } finally {
            pending.finish()
        }
    }
}

/** The home-screen widget. */
class BoardWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) = updateWidgetsAsync(context)

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) =
        updateWidgetsAsync(context) // resized: redraw at the new size

    override fun onEnabled(context: Context) = updateWidgetsAsync(context)

    override fun onDisabled(context: Context) = updateWidgetsAsync(context) // no widgets left: cancels the wake-ups
}

/** The next remark boundary or midnight has come. */
class AlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = updateWidgetsAsync(context)
}

/** Boot, clock, time-zone, language or app-update changes. */
class SystemReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = updateWidgetsAsync(context)
}

/** Runs when anything in the phone's calendars changes, then watches again. */
class CalendarChangeJob : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        val app = applicationContext
        worker.execute {
            try {
                WidgetUpdater.updateAll(app, scheduleContentJob = false)
            } catch (e: Exception) {
                Log.e("DayBoard", "widget update failed", e)
            } finally {
                jobFinished(params, false)
                // A content-trigger job fires once; arm it again for the next change.
                if (WidgetUpdater.widgetIds(app).isNotEmpty()) schedule(app)
            }
        }
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean = false

    companion object {
        private const val ID = 1

        fun schedule(context: Context) {
            if (!CalendarSource.hasPermission(context)) return
            val info = JobInfo.Builder(ID, ComponentName(context, CalendarChangeJob::class.java))
                .addTriggerContentUri(JobInfo.TriggerContentUri(CalendarContract.CONTENT_URI, JobInfo.TriggerContentUri.FLAG_NOTIFY_FOR_DESCENDANTS))
                .setTriggerContentUpdateDelay(2_000)
                .setTriggerContentMaxDelay(15_000)
                .build()
            context.getSystemService(JobScheduler::class.java).schedule(info)
        }

        fun cancel(context: Context) {
            context.getSystemService(JobScheduler::class.java).cancel(ID)
        }
    }
}
