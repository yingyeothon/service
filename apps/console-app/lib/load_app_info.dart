import 'package:yyt_console/app_info.dart';
import 'package:yyt_console/check_if_need_to_update.dart';
import 'package:yyt_console/remote_app.dart';

Future<List<AppInfo>> loadAppInfo(
  Future<List<RemoteApp>> Function({String? token}) fetchRemoteApp,
  Future<String?> Function(String) findInstalledVersion, {
  String? token,
}) async {
  final remoteApps = await fetchRemoteApp(token: token);

  // The platform-channel probes are independent; run them together instead
  // of one app at a time.
  return Future.wait(
    remoteApps.map((remoteApp) async {
      final installedVersion = await _resolveInstalledVersion(
        remoteApp,
        findInstalledVersion,
      );
      return AppInfo(
        id: remoteApp.id,
        name: remoteApp.name,
        package: remoteApp.package,
        description: remoteApp.description,
        latestArtifact: remoteApp.latestArtifact,
        installedVersion: installedVersion,
        needsUpdate: checkIfNeedToUpdate(remoteApp.version, installedVersion),
        home: remoteApp.home,
      );
    }),
  );
}

/// Probes each build variant's applicationId (release and `.debug`) and returns
/// the first installed version found, preferring the latest artifact's variant.
/// Version numbers are shared across variants, so the returned value compares
/// correctly against the catalog version regardless of which variant is present.
Future<String?> _resolveInstalledVersion(
  RemoteApp remoteApp,
  Future<String?> Function(String) findInstalledVersion,
) async {
  for (final applicationId in remoteApp.installCheckApplicationIds) {
    final installedVersion = await findInstalledVersion(applicationId);
    if (installedVersion != null) {
      return installedVersion;
    }
  }
  return null;
}
