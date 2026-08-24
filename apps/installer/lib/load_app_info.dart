import 'package:catalog/app_info.dart';
import 'package:catalog/check_if_need_to_update.dart';
import 'package:catalog/remote_app.dart';

Future<List<AppInfo>> loadAppInfo(
  Future<List<RemoteApp>> Function({String? token}) fetchRemoteApp,
  Future<String?> Function(String) findInstalledVersion, {
  String? token,
}) async {
  final remoteApps = await fetchRemoteApp(token: token);

  final List<AppInfo> infos = [];
  for (final remoteApp in remoteApps) {
    final installedVersion = await _resolveInstalledVersion(
      remoteApp,
      findInstalledVersion,
    );
    final needsUpdate = checkIfNeedToUpdate(
      remoteApp.version,
      installedVersion,
    );

    infos.add(
      AppInfo(
        name: remoteApp.name,
        package: remoteApp.package,
        description: remoteApp.description,
        latestArtifact: remoteApp.latestArtifact,
        installedVersion: installedVersion,
        needsUpdate: needsUpdate,
      ),
    );
  }
  return infos;
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
