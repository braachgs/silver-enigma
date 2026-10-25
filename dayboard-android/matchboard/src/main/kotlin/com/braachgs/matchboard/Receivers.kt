package com.braachgs.matchboard

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.util.Log
import java.util.concurrent.Executors

internal val worker = Executors.newSingleThreadExecutor()

/** Redraws off the main thread, keeping the receiver alive until it's done. */
internal fun BroadcastReceiver.inBackground(context: Context, work: (Context) -> Unit) {
    val pending = goAsync()
    val app = context.applicationContext
    worker.execute {
        try {
            work(app)
        } catch (e: Exception) {
            Log.e("MatchBoard", "widget update failed", e)
        } finally {
            pending.finish()
        }
    }
}

/** The home-screen widget. Drawing uses stored data; fetching is WorkManager's job. */
class MatchWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) = inBackground(context) { c ->
        Widgets.updateAll(c)
        Refresh.ensurePeriodic(c)
        val asOf = Store.feed(c).fetchedAt
        if (Store.apiKey(c).isNotEmpty() && (asOf == null || System.currentTimeMillis() - asOf > 15 * 60_000)) Refresh.now(c)
    }

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) =
        inBackground(context) { Widgets.updateAll(it) } // resized

    override fun onDisabled(context: Context) = inBackground(context) { c ->
        Refresh.stopAll(c)
        Widgets.cancelRedraw(c)
    }
}

/** A countdown flap changes (IN 20 MIN to IN 15 MIN, kickoff, midnight). */
class RedrawReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = inBackground(context) { Widgets.updateAll(it) }
}
