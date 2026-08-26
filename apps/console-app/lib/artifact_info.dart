class ArtifactInfo {
  final String id;
  final String url;
  final String platform;
  final int size;
  final Map<String, String> tags;
  final DateTime createdAt;

  ArtifactInfo({
    required this.id,
    required this.url,
    required this.platform,
    required this.size,
    required this.tags,
    required this.createdAt,
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
      createdAt:
          created is num
              ? DateTime.fromMillisecondsSinceEpoch(
                (created * 1000).toInt(),
                isUtc: true,
              )
              : DateTime.parse(created as String),
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

  bool get isInstallableAndroidApk {
    return platform.toLowerCase() == 'android' &&
        packageType.toLowerCase() == 'apk';
  }

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
