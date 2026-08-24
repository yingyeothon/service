import 'dart:convert';

import 'package:catalog/auth/auth_config.dart';
import 'package:http/http.dart' as http;

class ArtifactDeleteForbiddenException implements Exception {
  const ArtifactDeleteForbiddenException();

  @override
  String toString() => '아티팩트 삭제 권한이 없습니다.';
}

class ArtifactsApi {
  final String? _baseUrlOverride;

  ArtifactsApi({String? baseUrl}) : _baseUrlOverride = baseUrl;

  String get _baseUrl => _baseUrlOverride ?? AuthConfig.apiBaseUrl;

  Future<void> deleteArtifact({
    required String appName,
    required String artifactId,
    required String token,
  }) async {
    final url = Uri.parse(
      '$_baseUrl/catalog/apps/${Uri.encodeComponent(appName)}/artifacts/${Uri.encodeComponent(artifactId)}',
    );
    final response = await http.delete(
      url,
      headers: {'Authorization': 'Bearer $token'},
    );

    if (response.statusCode == 401) {
      throw Exception('인증이 만료되었습니다. 다시 로그인해주세요.');
    }
    if (response.statusCode == 403) {
      throw const ArtifactDeleteForbiddenException();
    }
    if (response.statusCode == 204 || response.statusCode == 200) {
      return;
    }

    final errorMessage = _extractErrorMessage(response.bodyBytes);
    throw Exception(errorMessage ?? '아티팩트 삭제 실패: ${response.statusCode}');
  }

  String? _extractErrorMessage(List<int> bodyBytes) {
    if (bodyBytes.isEmpty) {
      return null;
    }
    try {
      final data = jsonDecode(utf8.decode(bodyBytes));
      if (data is Map<String, dynamic>) {
        // Console envelope: {error:{message}}.
        final error = data['error'];
        if (error is Map<String, dynamic>) {
          final message = error['message'];
          if (message is String && message.isNotEmpty) {
            return message;
          }
        }
        final legacy = data['detail'] ?? data['title'];
        if (legacy is String && legacy.isNotEmpty) {
          return legacy;
        }
      }
    } catch (_) {
      return null;
    }
    return null;
  }
}
