package com.braachgs.matchboard

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import android.os.PowerManager
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.PeriodicWorkRequest
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import dayboard.match.MatchBoardBuilder
import java.time.ZoneId
import java.util.concurrent.TimeUnit

/**
 * When Match Board fetches:
 *  - every 15 minutes (WorkManager's shortest period; Android may stretch it in Doze);
 *  - two minutes after your club kicks off, so LIVE shows promptly;
 *  - every minute while your club's match is live, but only while the screen
 *    is on, Battery Saver is off, the phone isn't dozing and the app isn't
 *    battery-restricted. Otherwise it stays at 15 minutes.
 */
object Refresh {
    private const val PERIODIC = "periodic"
    private const val NOW = "now"
    private const val LIVE = "live"
    private const val KICKOFF = "kickoff"

    private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    private fun once(live: Boolean, delayMs: Long = 0): OneTimeWorkRequest =
        OneTimeWorkRequest.Builder(RefreshWorker::class.java)
            .setConstraints(online)
            .setInitialDelay(delayMs, TimeUnit.MILLISECONDS)
            .setInputData(Data.Builder().putBoolean(RefreshWorker.LIVE_ONLY, live).build())
            .build()

    fun ensurePeriodic(c: Context) {
        val req = PeriodicWorkRequest.Builder(RefreshWorker::class.java, 15, TimeUnit.MINUTES).setConstraints(online).build()
        WorkManager.getInstance(c).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, req)
    }

    fun now(c: Context) {
        WorkManager.getInstance(c).enqueueUniqueWork(NOW, ExistingWorkPolicy.REPLACE, once(false))
    }

    fun stopAll(c: Context) {
        WorkManager.getInstance(c).apply {
            cancelUniqueWork(PERIODIC); cancelUniqueWork(NOW); cancelUniqueWork(LIVE); cancelUniqueWork(KICKOFF)
        }
    }

    /** After each update: the minute-by-minute chain while your club is live, and the kickoff check. */
    fun plan(c: Context) {
        val wm = WorkManager.getInstance(c)
        val now = System.currentTimeMillis()
        val state = Store.feed(c, now)
        val pin = MatchBoardBuilder(ZoneId.systemDefault()).pinned(state.matches, Store.followed(c, state.matches), now)
        if (pin != null && pin.status.live && minuteUpdatesAllowed(c)) {
            wm.enqueueUniqueWork(LIVE, ExistingWorkPolicy.REPLACE, once(true, 60_000))
        } else {
            wm.cancelUniqueWork(LIVE)
        }
        if (pin != null && pin.status.upcoming && pin.kickoff > now && pin.kickoff - now < Store.DAY) {
            wm.enqueueUniqueWork(KICKOFF, ExistingWorkPolicy.REPLACE, once(false, pin.kickoff + 2 * 60_000 - now))
        }
    }

    /** Minute updates cost battery; only when Android isn't trying to save it and you could be looking. */
    fun minuteUpdatesAllowed(c: Context): Boolean {
        val pm = c.getSystemService(PowerManager::class.java)
        if (pm.isPowerSaveMode || !pm.isInteractive || pm.isDeviceIdleMode) return false
        if (Build.VERSION.SDK_INT >= 28 && c.getSystemService(ActivityManager::class.java).isBackgroundRestricted) return false
        return true
    }
}

class RefreshWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val c = applicationContext
        if (Store.apiKey(c).isEmpty()) {
            Widgets.updateAll(c)
            return Result.success()
        }
        Feed.refresh(c, liveOnly = inputData.getBoolean(LIVE_ONLY, false))
        Widgets.updateAll(c)
        Refresh.plan(c)
        // A failure is recorded and shown; the next scheduled update tries again.
        return Result.success()
    }

    companion object {
        const val LIVE_ONLY = "live_only"
    }
}
