import 'package:catalog/check_if_need_to_update.dart';

enum AppInstallState { notInstalled, old, latest, newerInstalled }

extension AppInstallStateExtension on AppInstallState {
  String get label {
    return '설치';
  }
}

AppInstallState resolveAppInstallState(
  String latestVersion,
  String? installedVersion,
) {
  if (installedVersion == null) {
    return AppInstallState.notInstalled;
  }

  try {
    final compare = compareVersions(latestVersion, installedVersion);
    if (compare > 0) {
      return AppInstallState.old;
    }
    if (compare < 0) {
      return AppInstallState.newerInstalled;
    }
    return AppInstallState.latest;
  } catch (_) {
    if (isSameVersion(latestVersion, installedVersion)) {
      return AppInstallState.latest;
    }
    return AppInstallState.old;
  }
}

bool isInstalledTargetVersion(String targetVersion, String? installedVersion) {
  return isSameVersion(targetVersion, installedVersion);
}

bool isOlderArtifactVersion(String version, String latestVersion) {
  try {
    return compareVersions(version, latestVersion) < 0;
  } catch (_) {
    return version.trim() != latestVersion.trim();
  }
}
