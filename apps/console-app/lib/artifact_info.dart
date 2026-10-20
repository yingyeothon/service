import 'package:flutter/foundation.dart';

/// The ad-hoc OTA links of an iOS artifact (`ios` of a catalog artifact; the
/// SPA's `types.ts` has the same shape).
class IosInstallLinks {
  const IosInstallLinks({required this.manifestUrl, required this.installUrl});

  final String manifestUrl;

  /// `itms-services://?action=download-manifest&url=…`: opened outside the
  /// app, it asks iOS to install from the manifest.
  final String installUrl;

  static IosInstallLinks? fromJson(Object? json) {
    if (json is! Map<String, dynamic>) return null;
    final manifest = json['manifestUrl'];
    final install = json['installUrl'];
    if (manifest is! String || install is! String || install.isEmpty) {
      return null;
    }
    return IosInstallLinks(manifestUrl: manifest, installUrl: install);
  }

  Map<String, dynamic> toJson() => {
    'manifestUrl': manifestUrl,
    'installUrl': installUrl,
  };
}

class ArtifactInfo {
  final String id;
  final String url;
  final String platform;
  final int size;
  final Map<String, String> tags;
  final DateTime createdAt;

  /// Present on an iOS artifact from a console that serves OTA links.
  final IosInstallLinks? ios;

  ArtifactInfo({
    required this.id,
    required this.url,
    required this.platform,
    required this.size,
    required this.tags,
    required this.createdAt,
    this.ios,
  });

  factory ArtifactInfo.fromJson(Map<String, dynamic> json) {
    // Parse tags map
    final tagsJson = json['tags'] as Map<String, dynamic>? ?? {};
    final tags = tagsJson.map((key, value) => MapEntry(key, value.toString()));

    final created = json['createdAt'];
    return ArtifactInfo(
      id: json['id'] as String,
      url: json['url'] as String,
      platform: (json['platform'] as String?) ?? '',
      size: (json['size'] as num?)?.toInt() ?? 0,
      tags: tags,
      // Console sends unix seconds; the legacy API sent an ISO string.
      createdAt: created is num
          ? DateTime.fromMillisecondsSinceEpoch(
              (created * 1000).toInt(),
              isUtc: true,
            )
          : DateTime.parse(created as String),
      ios: IosInstallLinks.fromJson(json['ios']),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'url': url,
      'platform': platform,
      'size': size,
      'tags': tags,
      'createdAt': createdAt.toIso8601String(),
      if (ios != null) 'ios': ios!.toJson(),
    };
  }

  String get version => tags['version'] ?? 'unknown';
  String get stage => tags['stage'] ?? '';
  String get changelog => tags['changelog'] ?? '';
  String get buildType => tags['build_type'] ?? '';
  String get packageType => tags['package_type'] ?? _packageTypeFromUrl;
  String get abi => tags['abi'] ?? '';
  String get arch => tags['arch'] ?? '';
  String get applicationId => tags['application_id'] ?? '';
  String get bundleId => tags['bundle_id'] ?? '';
  String get buildNumber => tags['build_number'] ?? '';

  /// The custom URL scheme the iOS app answers to (`url_scheme` tag); the
  /// app's "open" action launches `<scheme>://`.
  String get urlScheme => tags['url_scheme'] ?? '';

  bool get isIos => platform.toLowerCase() == 'ios';

  /// The version an install is compared by: an iOS build names its build
  /// number in a separate tag, appended here when the version carries none
  /// (the install ledger records the same form).
  String get comparableVersion =>
      isIos && buildNumber.isNotEmpty && !version.contains('+')
      ? '$version+$buildNumber'
      : version;

  /// The id the device knows the installed app by: the bundle id of an iOS
  /// build, the applicationId of the rest.
  String get installId => isIos ? bundleId : applicationId;

  bool get isInstallableAndroidApk {
    return platform.toLowerCase() == 'android' &&
        packageType.toLowerCase() == 'apk';
  }

  /// An APK on Android, an iOS build with an OTA link on iOS; nothing else
  /// (AAB, desktop, server, the other mobile platform) installs here.
  bool isInstallableOn(TargetPlatform device) => switch (device) {
    TargetPlatform.iOS => isIos && ios != null,
    TargetPlatform.android => isInstallableAndroidApk,
    _ => false,
  };

  bool get isInstallableOnThisDevice => isInstallableOn(defaultTargetPlatform);

  String get fileName {
    final uri = Uri.tryParse(url);
    if (uri == null || uri.pathSegments.isEmpty) {
      return '';
    }
    return Uri.decodeComponent(uri.pathSegments.last);
  }

  String get _packageTypeFromUrl {
    final lowerName = fileName.toLowerCase();
    if (lowerName.endsWith('.tar.gz')) {
      return 'tar.gz';
    }

    final dotIndex = lowerName.lastIndexOf('.');
    if (dotIndex < 0 || dotIndex == lowerName.length - 1) {
      return '';
    }
    return lowerName.substring(dotIndex + 1);
  }
}
