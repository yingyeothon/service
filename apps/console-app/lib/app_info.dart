import 'package:yyt_console/app_home.dart';
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

  /// Team + project of the app, when known (see [AppHome]).
  final AppHome? home;

  /// Shared with this member through a listing, not through a team seat.
  final bool shared;

  AppInfo({
    required this.id,
    required this.name,
    required this.package,
    required this.description,
    required this.latestArtifact,
    required this.installedVersion,
    required this.needsUpdate,
    this.home,
    this.shared = false,
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
