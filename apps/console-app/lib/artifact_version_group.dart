import 'package:yyt_console/app_install_state.dart';
import 'package:yyt_console/artifact_info.dart';
import 'package:yyt_console/catalog_platform.dart';

const unknownArtifactVersion = 'unknown';

class ArtifactVersionGroup {
  ArtifactVersionGroup({
    required this.version,
    required this.topArtifact,
    required this.artifacts,
  });

  final String version;
  final ArtifactInfo topArtifact;
  final List<ArtifactInfo> artifacts;

  DateTime get createdAt => topArtifact.createdAt;
  int get artifactCount => artifacts.length;
  int installableCount(String latestVersion) => artifacts
      .where((artifact) => canInstallArtifact(artifact, latestVersion))
      .length;
}

/// The newest artifact this device can install; `null` when there is none.
/// Under the `all` filter the newest build overall may be another
/// platform's, which must not decide what this device calls latest.
ArtifactInfo? latestInstallableArtifact(Iterable<ArtifactInfo> artifacts) {
  ArtifactInfo? latest;
  for (final a in artifacts) {
    if (!a.isInstallableOnThisDevice) continue;
    if (latest == null || _compareUploadOrder(a, latest) > 0) latest = a;
  }
  return latest;
}

/// Whether the detail screen offers [artifact] for install: it must install
/// on this device, and on iOS only the newest version is offered — whether
/// iOS installs a lower build over a higher one is unverified (todo/79).
bool canInstallArtifact(ArtifactInfo artifact, String latestVersion) =>
    artifact.isInstallableOnThisDevice &&
    !(isIosDevice() &&
        isOlderArtifactVersion(artifact.comparableVersion, latestVersion));

List<ArtifactVersionGroup> groupArtifactsByVersion(
  List<ArtifactInfo> artifacts,
) {
  final grouped = <String, List<ArtifactInfo>>{};
  for (final artifact in artifacts) {
    final version = artifact.version.trim().isEmpty
        ? unknownArtifactVersion
        : artifact.version.trim();
    grouped.putIfAbsent(version, () => <ArtifactInfo>[]).add(artifact);
  }

  final groups = grouped.entries.map((entry) {
    final orderedArtifacts = [...entry.value]
      ..sort((a, b) => _compareUploadOrder(b, a));
    return ArtifactVersionGroup(
      version: entry.key,
      topArtifact: orderedArtifacts.first,
      artifacts: orderedArtifacts,
    );
  }).toList();

  groups.sort((a, b) => _compareUploadOrder(b.topArtifact, a.topArtifact));
  return groups;
}

int _compareUploadOrder(ArtifactInfo a, ArtifactInfo b) {
  final createdCompare = a.createdAt.compareTo(b.createdAt);
  if (createdCompare != 0) {
    return createdCompare;
  }
  return a.id.compareTo(b.id);
}
