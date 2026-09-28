import 'package:yyt_console/app_home.dart';
import 'package:yyt_console/artifact_info.dart';

class RemoteApp {
  /// Console app id (`ca_…`); artifact routes are addressed by it.
  final String id;
  final String name;
  final String package;
  final String description;
  final ArtifactInfo latestArtifact;

  /// Distinct applicationIds across every artifact of the app. Build variants
  /// (release vs `.debug`) install under different applicationIds, so install
  /// checks must consider all of them, not just the latest artifact's id.
  final List<String> applicationIds;

  /// Team + project of the app, when the server sent the breadcrumb.
  final AppHome? home;

  /// Published to this member by name or to everyone (`access: "listing"`
  /// on the app list, or a browse row): install and update only, no entry
  /// into the project (docs/decisions.md *Catalog listings* #4).
  final bool shared;

  RemoteApp({
    required this.id,
    required this.name,
    required this.package,
    required this.description,
    required this.latestArtifact,
    List<String>? applicationIds,
    this.home,
    this.shared = false,
  }) : applicationIds = applicationIds ?? const <String>[];

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'name': name,
      'package': package,
      'description': description,
      'latestArtifact': latestArtifact.toJson(),
    };
  }

  String get version => latestArtifact.version;
  String get apkUrl => latestArtifact.url;
  String get applicationId =>
      latestArtifact.applicationId.isNotEmpty
          ? latestArtifact.applicationId
          : package;

  /// applicationIds to probe for installation, latest artifact's id first.
  List<String> get installCheckApplicationIds {
    final ids = <String>[];
    void add(String id) {
      if (id.isNotEmpty && !ids.contains(id)) {
        ids.add(id);
      }
    }

    add(applicationId);
    for (final id in applicationIds) {
      add(id);
    }
    return ids;
  }
}
