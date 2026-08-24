import 'package:pub_semver/pub_semver.dart';

class _CatalogVersion {
  const _CatalogVersion({required this.core, required this.buildNumber});

  final Version core;
  final int? buildNumber;
}

_CatalogVersion _parseCatalogVersion(String input) {
  final trimmed = input.trim();
  if (trimmed.isEmpty) {
    throw const FormatException('empty version');
  }

  final plusIndex = trimmed.indexOf('+');
  final coreText = plusIndex >= 0 ? trimmed.substring(0, plusIndex) : trimmed;
  final buildText =
      plusIndex >= 0 ? trimmed.substring(plusIndex + 1).trim() : null;

  return _CatalogVersion(
    core: Version.parse(coreText),
    buildNumber:
        buildText != null && RegExp(r'^\d+$').hasMatch(buildText)
            ? int.parse(buildText)
            : null,
  );
}

int compareVersions(String lhs, String rhs) {
  final left = _parseCatalogVersion(lhs);
  final right = _parseCatalogVersion(rhs);

  final coreCompare = left.core.compareTo(right.core);
  if (coreCompare != 0) {
    return coreCompare;
  }

  final leftBuild = left.buildNumber;
  final rightBuild = right.buildNumber;
  if (leftBuild != null && rightBuild != null) {
    return leftBuild.compareTo(rightBuild);
  }

  // Treat versions with the same release core as equivalent when only one side
  // exposes an Android/Flutter build suffix.
  return 0;
}

bool isSameVersion(String expectedVersion, String? actualVersion) {
  if (actualVersion == null) {
    return false;
  }

  try {
    return compareVersions(expectedVersion, actualVersion) == 0;
  } catch (_) {
    return expectedVersion.trim() == actualVersion.trim();
  }
}

bool checkIfNeedToUpdate(String newVersion, String? installedVersion) {
  if (installedVersion == null) {
    return true;
  }

  try {
    return compareVersions(newVersion, installedVersion) > 0;
  } catch (_) {
    return true;
  }
}

bool isDowngrade(String targetVersion, String? installedVersion) {
  if (installedVersion == null) {
    return false;
  }

  try {
    return compareVersions(targetVersion, installedVersion) < 0;
  } catch (_) {
    return false;
  }
}
