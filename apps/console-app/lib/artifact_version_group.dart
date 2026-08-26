import 'package:yyt_console/artifact_info.dart';

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
  int get installableCount =>
      artifacts.where((artifact) => artifact.isInstallableAndroidApk).length;
}

List<ArtifactVersionGroup> groupArtifactsByVersion(
  List<ArtifactInfo> artifacts,
) {
  final grouped = <String, List<ArtifactInfo>>{};
  for (final artifact in artifacts) {
    final version =
        artifact.version.trim().isEmpty
            ? unknownArtifactVersion
            : artifact.version.trim();
    grouped.putIfAbsent(version, () => <ArtifactInfo>[]).add(artifact);
  }

  final groups =
      grouped.entries.map((entry) {
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
