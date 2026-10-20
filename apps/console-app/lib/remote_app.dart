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

  /// Distinct bundle ids (`bundle_id` tags) across the app's iOS artifacts;
  /// empty from a console that predates them.
  final List<String> bundleIds;

  /// Team + project of the app, when the server sent the breadcrumb.
  final AppHome? home;

  /// Published to this member by name or to everyone (`access: "listing"`
  /// on the app list, or a browse row): install and update only, no entry
  /// into the project (docs/decisions.md *Catalog listings* #4).
  final bool shared;

  /// The FCM topic the server announces this app's new Android builds on;
  /// `null` from a console that predates it. Never built on the device.
  final String? topic;

  RemoteApp({
    required this.id,
    required this.name,
    required this.package,
    required this.description,
    required this.latestArtifact,
    List<String>? applicationIds,
    List<String>? bundleIds,
    this.home,
    this.shared = false,
    this.topic,
  }) : applicationIds = applicationIds ?? const <String>[],
       bundleIds = bundleIds ?? const <String>[];

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'name': name,
      'package': package,
      'description': description,
      'latestArtifact': latestArtifact.toJson(),
    };
  }

  String get version => latestArtifact.comparableVersion;
  String get apkUrl => latestArtifact.url;
  String get applicationId =>
      latestArtifact.installId.isNotEmpty ? latestArtifact.installId : package;

  /// Ids to probe for installation, latest artifact's id first: the bundle
  /// ids for an iOS build, the applicationIds for the rest.
  List<String> get installCheckApplicationIds {
    final ids = <String>[];
    void add(String id) {
      if (id.isNotEmpty && !ids.contains(id)) {
        ids.add(id);
      }
    }

    add(applicationId);
    for (final id in latestArtifact.isIos ? bundleIds : applicationIds) {
      add(id);
    }
    return ids;
  }
}
