import 'dart:convert';

import 'package:catalog/auth/auth_config.dart';
import 'package:http/http.dart' as http;

/// Console permission view: `{id, login, pending, level, createdAt}`.
class Permission {
  final String id;
  final String username;
  final bool pending;
  final String permissionLevel;
  final DateTime createdAt;

  Permission({
    required this.id,
    required this.username,
    required this.pending,
    required this.permissionLevel,
    required this.createdAt,
  });

  factory Permission.fromJson(Map<String, dynamic> json) {
    return Permission(
      id: json['id'] as String,
      username: (json['login'] as String?) ?? '?',
      pending: json['pending'] as bool? ?? false,
      permissionLevel: json['level'] as String,
      createdAt: DateTime.fromMillisecondsSinceEpoch(
        ((json['createdAt'] as num?)?.toInt() ?? 0) * 1000,
        isUtc: true,
      ),
    );
  }
}

class PermissionsApi {
  final String? _baseUrlOverride;

  PermissionsApi({String? baseUrl}) : _baseUrlOverride = baseUrl;

  String _permissionsUrl(String appName) =>
      _baseUrlOverride != null
          ? '$_baseUrlOverride/catalog/apps/${Uri.encodeComponent(appName)}/permissions'
          : AuthConfig.appPermissionsUrl(appName);

  List<Permission> _parseList(List<int> bodyBytes) {
    final body = jsonDecode(utf8.decode(bodyBytes)) as Map<String, dynamic>;
    return (body['permissions'] as List<dynamic>)
        .map((json) => Permission.fromJson(json as Map<String, dynamic>))
        .toList();
  }

  String? _errorMessage(List<int> bodyBytes) {
    try {
      final decoded = jsonDecode(utf8.decode(bodyBytes));
      final error = (decoded as Map<String, dynamic>)['error'];
      final message = (error as Map<String, dynamic>?)?['message'];
      return message is String ? message : null;
    } catch (_) {
      return null;
    }
  }

  Never _throwFor(http.Response response, String fallback) {
    if (response.statusCode == 401) {
      throw Exception('인증이 만료되었습니다. 다시 로그인해주세요.');
    }
    if (response.statusCode == 403) {
      throw Exception('권한 관리는 앱 소유자 또는 관리자만 할 수 있습니다.');
    }
    throw Exception(
      _errorMessage(response.bodyBytes) ??
          '$fallback: ${response.statusCode}',
    );
  }

  Future<List<Permission>> listAppPermissions(
    String appName,
    String token,
  ) async {
    final response = await http.get(
      Uri.parse(_permissionsUrl(appName)),
      headers: {'Authorization': 'Bearer $token'},
    );
    if (response.statusCode != 200) {
      _throwFor(response, '권한 목록 조회 실패');
    }
    return _parseList(response.bodyBytes);
  }

  /// Upsert: granting an existing member just changes the level.
  Future<List<Permission>> addAppPermission(
    String appName,
    String username,
    String level,
    String token,
  ) async {
    final response = await http.post(
      Uri.parse(_permissionsUrl(appName)),
      headers: {
        'Authorization': 'Bearer $token',
        'Content-Type': 'application/json',
      },
      body: jsonEncode({'login': username, 'level': level}),
    );
    if (response.statusCode != 200 && response.statusCode != 201) {
      _throwFor(response, '권한 추가 실패');
    }
    return _parseList(response.bodyBytes);
  }

  Future<void> removeAppPermission(
    String appName,
    String permissionId,
    String token,
  ) async {
    final response = await http.delete(
      Uri.parse(
        '${_permissionsUrl(appName)}/${Uri.encodeComponent(permissionId)}',
      ),
      headers: {'Authorization': 'Bearer $token'},
    );
    if (response.statusCode != 204 && response.statusCode != 200) {
      _throwFor(response, '권한 삭제 실패');
    }
  }
}
