class AuthConfig {
  static String? _serverUrl;

  static bool get hasServerUrl => _serverUrl != null;
  static String? get serverUrl => _serverUrl;

  static String get apiBaseUrl {
    final baseUrl = _serverUrl;
    if (baseUrl == null) {
      throw StateError('서버 주소가 설정되지 않았습니다.');
    }
    return baseUrl;
  }

  static String normalizeServerUrl(String input) {
    final trimmed = input.trim();
    if (trimmed.isEmpty) {
      throw const FormatException('서버 주소를 입력해주세요.');
    }

    final withScheme = trimmed.contains('://') ? trimmed : 'https://$trimmed';
    final parsed = Uri.tryParse(withScheme);
    if (parsed == null) {
      throw const FormatException('서버 주소 형식이 올바르지 않습니다.');
    }
    if (parsed.scheme != 'http' && parsed.scheme != 'https') {
      throw const FormatException('http 또는 https 주소만 지원합니다.');
    }
    if (parsed.host.isEmpty) {
      throw const FormatException('호스트가 포함된 서버 주소를 입력해주세요.');
    }
    if (parsed.query.isNotEmpty || parsed.fragment.isNotEmpty) {
      throw const FormatException('쿼리/프래그먼트가 없는 서버 주소를 입력해주세요.');
    }

    final path = parsed.path.trim();
    if (path.isNotEmpty && path != '/') {
      throw const FormatException('경로 없이 도메인까지만 입력해주세요.');
    }

    return Uri(
      scheme: parsed.scheme,
      userInfo: parsed.userInfo,
      host: parsed.host,
      port: parsed.hasPort ? parsed.port : null,
    ).toString();
  }

  static String setServerUrl(String input) {
    final normalized = normalizeServerUrl(input);
    _serverUrl = normalized;
    return normalized;
  }

  static void clearServerUrl() {
    _serverUrl = null;
  }

  // Console API (services/console): the catalog lives under /catalog and the
  // device flow under /auth/device (docs/decisions.md "Binary catalog").
  // Tokens are probed with /me; the app list is the flattened compatibility
  // route (every app of every team the caller is seated in); artifact routes
  // are keyed by app id (docs/decisions.md "Teams and projects").
  static String get meUrl => '$apiBaseUrl/me';
  static String get appsUrl => '$apiBaseUrl/catalog/apps';
  static String appArtifactsUrl(String appId) =>
      '$apiBaseUrl/catalog/apps/${Uri.encodeComponent(appId)}/artifacts';
  static String appArtifactUrl(String appId, String artifactId) =>
      '${appArtifactsUrl(appId)}/${Uri.encodeComponent(artifactId)}';

  static String get authDeviceCodeUrl => '$apiBaseUrl/auth/device/start';
  static String get authDeviceTokenUrl => '$apiBaseUrl/auth/device/token';
}
