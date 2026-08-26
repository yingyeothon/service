import 'package:yyt_console/artifact_info.dart';

class AppInfo {
  /// Console app id (`ca_…`).
  final String id;
  final String name;
  final String package;
  final String description;
  final ArtifactInfo latestArtifact;
  final String? installedVersion;
  final bool needsUpdate;

  AppInfo({
    required this.id,
    required this.name,
    required this.package,
    required this.description,
    required this.latestArtifact,
    required this.installedVersion,
    required this.needsUpdate,
  });

  String get version => latestArtifact.version;
  String get apkUrl => latestArtifact.url;
  Map<String, String> get tags => latestArtifact.tags;
  String get releaseNote =>
      latestArtifact.changelog.isNotEmpty
          ? latestArtifact.changelog
          : description;
  String get buildType => latestArtifact.buildType;
  String get applicationId =>
      latestArtifact.applicationId.isNotEmpty
          ? latestArtifact.applicationId
          : package;
}
