import 'package:yyt_console/device_apps.dart';

Future<String?> findInstalledVersion(String packageName) async {
  final isInstalled = await DeviceApps.isAppInstalled(packageName);
  if (!isInstalled) {
    return null;
  }

  final version = await DeviceApps.getVersionName(packageName);
  return version;
}
