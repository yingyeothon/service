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
    if (parsed.userInfo.isNotEmpty) {
      // `https://console.yyt.life@evil.example` would read as the real
      // console while every token goes to `evil.example`.
      throw const FormatException('사용자 정보(@)가 포함된 서버 주소는 사용할 수 없습니다.');
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

  // Console API (services/console): the catalog lives under /catalog
  // (docs/decisions.md "Binary catalog"); login is an API key from a QR.
  // Tokens are probed with /me; apps are listed per team (`/teams` then
  // `/teams/{id}/catalog/apps`, the permanent routes); artifact routes are
  // keyed by app id (docs/decisions.md "Teams and projects").
  //
  // The `…Of(base, …)` forms take the server explicitly: a request sequence
  // captures the active profile's server once, together with its token, so a
  // profile switch mid-flight can never send one profile's key to another's
  // host. The getters are conveniences for one-shot calls.
  static String meUrlOf(String base) => '$base/me';
  static String teamsUrlOf(String base) => '$base/teams';
  static String teamAppsUrlOf(String base, String teamId) =>
      '$base/teams/${Uri.encodeComponent(teamId)}/catalog/apps';
  static String teamProjectsUrlOf(String base, String teamId) =>
      '$base/teams/${Uri.encodeComponent(teamId)}/projects';
  static String teamIssuesUrlOf(String base, String teamId) =>
      '$base/teams/${Uri.encodeComponent(teamId)}/issues';
  static String teamDiscussionsUrlOf(String base, String teamId) =>
      '$base/teams/${Uri.encodeComponent(teamId)}/discussions';
  static String teamDiscussionUrlOf(String base, String teamId, String id) =>
      '${teamDiscussionsUrlOf(base, teamId)}/${Uri.encodeComponent(id)}';
  static String projectIssuesUrlOf(String base, String projectId) =>
      '$base/projects/${Uri.encodeComponent(projectId)}/issues';
  static String projectIssueUrlOf(String base, String projectId, int number) =>
      '${projectIssuesUrlOf(base, projectId)}/$number';
  static String installerDownloadsUrlOf(String base) =>
      '$base/catalog/installer/downloads';
  static String appArtifactsUrlOf(String base, String appId) =>
      '$base/catalog/apps/${Uri.encodeComponent(appId)}/artifacts';

  static String get meUrl => meUrlOf(apiBaseUrl);
  static String get teamsUrl => teamsUrlOf(apiBaseUrl);
  static String teamAppsUrl(String teamId) => teamAppsUrlOf(apiBaseUrl, teamId);
  static String teamProjectsUrl(String teamId) =>
      teamProjectsUrlOf(apiBaseUrl, teamId);
  static String projectIssuesUrl(String projectId) =>
      projectIssuesUrlOf(apiBaseUrl, projectId);
  static String projectIssueUrl(String projectId, int number) =>
      projectIssueUrlOf(apiBaseUrl, projectId, number);
  static String appArtifactsUrl(String appId) =>
      appArtifactsUrlOf(apiBaseUrl, appId);
  static String appArtifactUrl(String appId, String artifactId) =>
      '${appArtifactsUrl(appId)}/${Uri.encodeComponent(artifactId)}';
}
