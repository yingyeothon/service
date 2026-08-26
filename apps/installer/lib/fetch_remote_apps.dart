import 'dart:convert';
import 'dart:math';

import 'package:catalog/artifact_info.dart';
import 'package:catalog/artifact_version_group.dart';
import 'package:catalog/auth/auth_config.dart';
import 'package:catalog/remote_app.dart';
import 'package:http/http.dart' as http;

class UnauthorizedException implements Exception {
  UnauthorizedException(this.message);

  final String message;

  @override
  String toString() => 'UnauthorizedException: $message';
}

Future<List<RemoteApp>> fetchRemoteApps({String? token}) async {
  if (token == null || token.isEmpty) {
    throw UnauthorizedException('로그인이 필요합니다.');
  }

  final headers = <String, String>{'Authorization': 'Bearer $token'};
  final appsResponse = await http.get(
    Uri.parse(AuthConfig.appsUrl),
    headers: headers,
  );

  if (appsResponse.statusCode == 401) {
    throw UnauthorizedException('인증이 만료되었습니다. 다시 로그인해주세요.');
  }
  if (appsResponse.statusCode == 403) {
    // /me accepts a pending member; the catalog does not. Say so instead of a
    // bare status code.
    throw Exception('아직 승인되지 않은 계정입니다. 관리자 승인 후 다시 시도해주세요.');
  }
  if (appsResponse.statusCode != 200) {
    throw Exception('앱 목록 조회 실패: ${appsResponse.statusCode}');
  }

  // Console envelope: {"apps": [...]}.
  final appsBody =
      jsonDecode(utf8.decode(appsResponse.bodyBytes)) as Map<String, dynamic>;
  final appMaps =
      (appsBody['apps'] as List<dynamic>).cast<Map<String, dynamic>>();

  final results = <RemoteApp>[];
  const maxParallel = 5;

  for (var i = 0; i < appMaps.length; i += maxParallel) {
    final end = min(i + maxParallel, appMaps.length);
    final batch = appMaps.sublist(i, end);
    final batchResults = await Future.wait(
      batch.map((appJson) => _toRemoteApp(appJson, token: token)),
    );
    results.addAll(batchResults.whereType<RemoteApp>());
  }

  results.sort(
    (a, b) => b.latestArtifact.createdAt.compareTo(a.latestArtifact.createdAt),
  );
  return results;
}

Future<List<ArtifactInfo>> fetchAppArtifacts({
  required String appId,
  required String token,
  String platform = 'android',
}) async {
  final uri = Uri.parse(
    '${AuthConfig.appArtifactsUrl(appId)}?platform=$platform',
  );
  final response = await http.get(
    uri,
    headers: {'Authorization': 'Bearer $token'},
  );

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

Future<RemoteApp?> _toRemoteApp(
  Map<String, dynamic> appJson, {
  required String token,
}) async {
  final id = appJson['id'] as String?;
  final name = appJson['name'] as String?;
  final packageName = appJson['path'] as String?;
  if (id == null || name == null || packageName == null) {
    return null;
  }

  final artifactsUri = Uri.parse(
    '${AuthConfig.appArtifactsUrl(id)}?platform=android',
  );
  final response = await http.get(
    artifactsUri,
    headers: {'Authorization': 'Bearer $token'},
  );

  if (response.statusCode == 401) {
    throw UnauthorizedException('인증이 만료되었습니다. 다시 로그인해주세요.');
  }
  if (response.statusCode != 200) {
    return null;
  }

  final artifactsBody =
      jsonDecode(utf8.decode(response.bodyBytes)) as Map<String, dynamic>;
  final artifactsJson = artifactsBody['artifacts'] as List<dynamic>;
  if (artifactsJson.isEmpty) {
    return null;
  }

  final artifacts =
      artifactsJson
          .map((item) => ArtifactInfo.fromJson(item as Map<String, dynamic>))
          .where((artifact) => artifact.platform.toLowerCase() == 'android')
          .toList();
  if (artifacts.isEmpty) {
    return null;
  }

  final versionGroups = groupArtifactsByVersion(artifacts);
  if (versionGroups.isEmpty) {
    return null;
  }
  final latestArtifact = versionGroups.first.topArtifact;

  final applicationIds =
      <String>{
        for (final artifact in artifacts)
          if (artifact.applicationId.isNotEmpty) artifact.applicationId,
      }.toList();

  return RemoteApp(
    id: id,
    name: name,
    package: packageName,
    description: (appJson['description'] as String?) ?? '',
    latestArtifact: latestArtifact,
    applicationIds: applicationIds,
  );
}
