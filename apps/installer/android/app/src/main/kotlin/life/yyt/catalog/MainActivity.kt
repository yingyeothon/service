package life.yyt.catalog

import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private val CHANNEL = "life.yyt.catalog/appcheck"

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
    }
}
