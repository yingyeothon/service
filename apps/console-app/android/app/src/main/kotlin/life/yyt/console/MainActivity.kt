package life.yyt.console

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import android.view.WindowManager
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.util.UUID

class MainActivity : FlutterActivity() {
    private val CHANNEL = "life.yyt.console/appcheck"

    // One-time credential screens (lib/secure_window.dart).
    private val WINDOW_CHANNEL = "life.yyt.console/window"

    // Timed clipboard clears. The main looper, not the activity: the clear
    // must run after the user has switched to the app they paste into.
    private val clipHandler = Handler(Looper.getMainLooper())

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL).setMethodCallHandler {
            call, result ->
            val pm = applicationContext.packageManager
            when (call.method) {
                "isAppInstalled" -> {
                    val packageName = call.argument<String>("packageName")!!
                    try {
                        pm.getPackageInfo(packageName, 0)
                        result.success(true)
                    } catch (e: PackageManager.NameNotFoundException) {
                        result.success(false)
                    }
                }

                "getAppVersion" -> {
                    val packageName = call.argument<String>("packageName")!!
                    try {
                        val info = pm.getPackageInfo(packageName, 0)
                        result.success(info.versionName)
                    } catch (e: PackageManager.NameNotFoundException) {
                        result.success(null)
                    }
                }

                "launchApp" -> {
                    val packageName = call.argument<String>("packageName")!!
                    val launchIntent = pm.getLaunchIntentForPackage(packageName)
                    if (launchIntent != null) {
                        launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        applicationContext.startActivity(launchIntent)
                        result.success(null)
                    } else {
                        result.error("APP_NOT_FOUND", "Cannot launch $packageName", null)
                    }
                }

                "uninstallApp" -> {
                    val packageName = call.argument<String>("packageName")!!
                    val uninstallIntent =
                        Intent(Intent.ACTION_DELETE, Uri.parse("package:$packageName"))
                    uninstallIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    applicationContext.startActivity(uninstallIntent)
                    result.success(true)
                }

                else -> result.notImplemented()
            }
        }

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, WINDOW_CHANNEL).setMethodCallHandler {
            call, result ->
            when (call.method) {
                "setSecure" -> {
                    val secure = call.argument<Boolean>("secure") == true
                    // FLAG_SECURE covers the whole (single) activity: every set
                    // is paired with a clear by the Dart side.
                    runOnUiThread {
                        if (secure) {
                            window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
                        } else {
                            window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
                        }
                        result.success(null)
                    }
                }

                "copySensitive" -> {
                    val text = call.argument<String>("text") ?: ""
                    val clearAfterMs = call.argument<Number>("clearAfterMs")?.toLong() ?: 0L
                    // The application context: a pending clear must not hold
                    // the activity (see clearIfStill).
                    val clipboard =
                        applicationContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    // A label unique to this copy: the timed clear touches the
                    // clipboard only while it still holds this very clip.
                    val label = "$SENSITIVE_CLIP_LABEL:${UUID.randomUUID()}"
                    val clip = ClipData.newPlainText(label, text)
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                        // Keeps the value out of the Android 13+ clipboard preview;
                        // some keyboards read the string extra on older releases.
                        clip.description.extras = PersistableBundle().apply {
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                                putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true)
                            } else {
                                putBoolean("android.content.extra.IS_SENSITIVE", true)
                            }
                        }
                    }
                    clipboard.setPrimaryClip(clip)
                    if (clearAfterMs > 0) {
                        clipHandler.postDelayed({ clearIfStill(clipboard, label) }, clearAfterMs)
                    }
                    result.success(null)
                }

                else -> result.notImplemented()
            }
        }
    }

    companion object {
        private const val SENSITIVE_CLIP_LABEL = "life.yyt.console/sensitive"

        /**
         * Clears the clipboard if its primary clip still carries [label]. From
         * Android 10 a backgrounded app cannot read the clip's content, but the
         * description (and its label) stays readable on most releases; when it
         * is not (null, or refused), the clip is left alone rather than guessed
         * at. Static, so a pending clear holds no activity; a process killed
         * before it runs leaves the clip in place.
         */
        private fun clearIfStill(clipboard: ClipboardManager, label: String) {
            val current =
                try {
                    clipboard.primaryClipDescription?.label?.toString()
                } catch (e: SecurityException) {
                    null
                }
            if (current != label) return
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                clipboard.clearPrimaryClip()
            } else {
                clipboard.setPrimaryClip(ClipData.newPlainText("", ""))
            }
        }
    }
}
