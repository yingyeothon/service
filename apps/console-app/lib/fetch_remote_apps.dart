import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:yyt_console/app_home.dart';
import 'package:yyt_console/artifact_info.dart';
import 'package:yyt_console/auth/auth_config.dart';
import 'package:yyt_console/remote_app.dart';
import 'package:http/http.dart' as http;

class UnauthorizedException implements Exception {
  UnauthorizedException(this.message);

  final String message;

  @override
  String toString() => 'UnauthorizedException: $message';
}

/// How long a catalog request may take before it counts as failed: the list
/// screen then shows its retry card, and the update banner, which waits for
/// the first list load, is not held up behind it.
const catalogRequestTimeout = Duration(seconds: 20);

/// The whole app list in one request: `GET /catalog/apps?artifacts=summary&platform=android`
/// answers every app of every team the caller is seated in, each with its
/// newest Android artifact and application ids, plus `teams` — the caller's
/// seat in each of those teams. One request matters on Lambda: a container
/// serves one request at a time, so the former `/teams` + one request per
/// team put a cold container on the launch path for each concurrent request.
Future<List<RemoteApp>> fetchRemoteApps({
  String? token,
  http.Client? client,
  String? baseUrl,
  Duration timeout = catalogRequestTimeout,
}) async {
  if (token == null || token.isEmpty) {
    throw UnauthorizedException('로그인이 필요합니다.');
  }
  // Captured once with the token: a profile switch mid-load must not send
  // this token to the other profile's server.
  final base = baseUrl ?? AuthConfig.apiBaseUrl;
  final http.Client c = client ?? http.Client();
  try {
    final response = await c
        .get(
          Uri.parse(AuthConfig.catalogAppsUrlOf(base)).replace(
            queryParameters: const {
              'artifacts': 'summary',
              'platform': 'android',
            },
          ),
          headers: {'Authorization': 'Bearer $token'},
        )
        .timeout(timeout);
    if (response.statusCode == 401) {
      throw UnauthorizedException('인증이 만료되었습니다. 다시 로그인해주세요.');
    }
    if (response.statusCode == 403) {
      // /me accepts a pending member; the list does not. Say so instead of a
      // bare status code.
      throw Exception('아직 승인되지 않은 계정입니다. 관리자 승인 후 다시 시도해주세요.');
    }
    if (response.statusCode != 200) {
      throw Exception('앱 목록 조회 실패: ${response.statusCode}');
    }
    final body =
        jsonDecode(utf8.decode(response.bodyBytes)) as Map<String, dynamic>;
    // The caller's seat per team feeds the detail screen's issues button. An
    // older console sends no `teams`; the seat then reads as `member`.
    final roleOf = <String, String>{
      for (final team in (body['teams'] as List<dynamic>? ?? const []))
        if (team is Map<String, dynamic> &&
            team['id'] is String &&
            team['role'] is String)
          team['id'] as String: team['role'] as String,
    };
    final appMaps = [
      for (final app
          in (body['apps'] as List<dynamic>).cast<Map<String, dynamic>>())
        {...app, 'teamRole': roleOf[app['teamId']] ?? 'member'},
    ];

    // A console that predates the flattened summary ignores the query and
    // answers without the key (`null` means "no artifact"); fill those from
    // the per-app walk so an updated app never shows an empty list against an
    // older server.
    final results = <RemoteApp>[];
    final legacy = <Map<String, dynamic>>[];
    for (final appJson in appMaps) {
      if (!appJson.containsKey('latestArtifact')) {
        legacy.add(appJson);
      } else if (_toRemoteApp(appJson) case final app?) {
        results.add(app);
      }
    }
    const maxParallel = 5;
    for (var i = 0; i < legacy.length; i += maxParallel) {
      final batch = legacy.sublist(i, min(i + maxParallel, legacy.length));
      results.addAll(
        (await Future.wait(
          batch.map((a) => _withFetchedArtifacts(a, c, token, base)),
        )).whereType<RemoteApp>(),
      );
    }
    results.sort(
      (a, b) =>
          b.latestArtifact.createdAt.compareTo(a.latestArtifact.createdAt),
    );
    return results;
  } finally {
    if (client == null) c.close();
  }
}

Future<List<ArtifactInfo>> fetchAppArtifacts({
  required String appId,
  required String token,
  String platform = 'android',
  String? baseUrl,
  http.Client? client,
}) async {
  final uri = Uri.parse(
    '${AuthConfig.appArtifactsUrlOf(baseUrl ?? AuthConfig.apiBaseUrl, appId)}?platform=$platform',
  );
  final http.Client c = client ?? http.Client();
  final http.Response response;
  try {
    response = await c
        .get(uri, headers: {'Authorization': 'Bearer $token'})
        .timeout(catalogRequestTimeout);
  } finally {
    if (client == null) c.close();
  }

  if (response.statusCode == 401) {
    throw UnauthorizedException('인증이 만료되었습니다. 다시 로그인해주세요.');
  }
  if (response.statusCode != 200) {
    throw Exception('아티팩트 목록 조회 실패: ${response.statusCode}');
  }

  final body =
      jsonDecode(utf8.decode(response.bodyBytes)) as Map<String, dynamic>;
  final artifacts =
      (body['artifacts'] as List<dynamic>)
          .map((item) => ArtifactInfo.fromJson(item as Map<String, dynamic>))
          .toList();

  artifacts.sort((a, b) => b.createdAt.compareTo(a.createdAt));
  return artifacts;
}

/// Legacy path: fills the summary fields from `/catalog/apps/{id}/artifacts`.
Future<RemoteApp?> _withFetchedArtifacts(
  Map<String, dynamic> appJson,
  http.Client c,
  String token,
  String base,
) async {
  final id = appJson['id'];
  if (id is! String) return null;
  final List<ArtifactInfo> artifacts;
  try {
    artifacts = await fetchAppArtifacts(
      appId: id,
      token: token,
      baseUrl: base,
      client: c,
    );
  } on UnauthorizedException {
    rethrow;
  } catch (_) {
    return null; // one app failing must not hide the others
  }
  // Newest first, as the server orders them: the first is the summary's pick.
  final android =
      artifacts.where((a) => a.platform.toLowerCase() == 'android').toList();
  if (android.isEmpty) return null;
  return _toRemoteApp({
    ...appJson,
    'latestArtifact': android.first.toJson(),
    'applicationIds':
        <String>{
          for (final a in android)
            if (a.applicationId.isNotEmpty) a.applicationId,
        }.toList(),
  });
}

/// Builds an app from the `artifacts=summary` view; apps without an Android
/// artifact are skipped, like before.
RemoteApp? _toRemoteApp(Map<String, dynamic> appJson) {
  final id = appJson['id'] as String?;
  final name = appJson['name'] as String?;
  final packageName = appJson['path'] as String?;
  final latestJson = appJson['latestArtifact'];
  if (id == null ||
      name == null ||
      packageName == null ||
      latestJson is! Map<String, dynamic>) {
    return null;
  }
  final latestArtifact = ArtifactInfo.fromJson(latestJson);
  if (latestArtifact.platform.toLowerCase() != 'android') {
    return null;
  }
  final applicationIds = <String>[
    for (final v in (appJson['applicationIds'] as List<dynamic>? ?? const []))
      if (v is String && v.isNotEmpty) v,
  ];
  return RemoteApp(
    id: id,
    name: name,
    package: packageName,
    description: (appJson['description'] as String?) ?? '',
    latestArtifact: latestArtifact,
    applicationIds: applicationIds,
    home: AppHome.fromAppJson(appJson),
  );
}
