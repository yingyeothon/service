import 'package:yyt_console/catalog_platform.dart';
import 'package:yyt_console/device_apps.dart';
import 'package:yyt_console/ios_install_ledger.dart';

/// The installed version of [packageName]: the package manager's answer on
/// Android; on iOS, which cannot see other apps, the version this device last
/// asked iOS to install under that bundle id ([IosInstallLedger]).
Future<String?> findInstalledVersion(String packageName) async {
  if (isIosDevice()) {
    return (await IosInstallLedger.instance.lookup(
      packageName,
    ))?.comparableVersion;
  }
  final isInstalled = await DeviceApps.isAppInstalled(packageName);
  if (!isInstalled) {
    return null;
  }

  final version = await DeviceApps.getVersionName(packageName);
  return version;
}
