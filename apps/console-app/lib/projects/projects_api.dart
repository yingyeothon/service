import 'dart:convert';

import 'package:yyt_console/auth/auth_config.dart';
import 'package:yyt_console/fetch_remote_apps.dart' show UnauthorizedException;
import 'package:yyt_console/projects/models.dart';
import 'package:http/http.dart' as http;

/// A console API error with the server's message (`{error:{code,message}}`).
class ApiException implements Exception {
  const ApiException(this.status, this.message, {this.code});

  final int status;
  final String message;
  final String? code;

  @override
  String toString() => message;
}

/// Teams → projects → issues → comments, plus team discussions, over the
/// console API. Every call
/// carries the saved token; 401 surfaces as [UnauthorizedException] so the
/// caller logs out like the app list does.
class ProjectsApi {
  ProjectsApi({required this.token, http.Client? client, String? baseUrl})
    : _client = client ?? http.Client(),
      _ownsClient = client == null,
      // Captured once: a profile switch must not redirect in-flight calls.
      baseUrl = baseUrl ?? AuthConfig.apiBaseUrl;

  final String token;
  final String baseUrl;
  final http.Client _client;
  final bool _ownsClient;

  /// Releases the connection pool when the owning screen is disposed.
  void close() {
    if (_ownsClient) _client.close();
  }

  Future<List<Team>> listTeams() async {
    final body = await _get(AuthConfig.teamsUrlOf(baseUrl));
    return _list(body['teams']).map(Team.fromJson).toList();
  }

  Future<List<Project>> listProjects(String teamId) async {
    final body = await _get(AuthConfig.teamProjectsUrlOf(baseUrl, teamId));
    return _list(body['projects']).map(Project.fromJson).toList();
  }

  Future<List<Issue>> listIssues(String projectId, {String? status}) async {
    final url =
        status == null
            ? AuthConfig.projectIssuesUrlOf(baseUrl, projectId)
            : '${AuthConfig.projectIssuesUrlOf(baseUrl, projectId)}?status=$status';
    final body = await _get(url);
    return _list(body['issues']).map(Issue.fromJson).toList();
  }

  Future<Issue> getIssue(String projectId, int number) async => Issue.fromJson(
    _object(
      await _get(AuthConfig.projectIssueUrlOf(baseUrl, projectId, number)),
    ),
  );

  Future<Issue> createIssue(
    String projectId, {
    required String title,
    String bodyMd = '',
  }) async => Issue.fromJson(
    _object(
      await _post(AuthConfig.projectIssuesUrlOf(baseUrl, projectId), {
        'title': title,
        'bodyMd': bodyMd,
      }),
    ),
  );

  Future<Issue> setIssueStatus(
    String projectId,
    int number, {
    required bool open,
  }) async => Issue.fromJson(
    _object(
      await _post(
        '${AuthConfig.projectIssueUrlOf(baseUrl, projectId, number)}/${open ? 'reopen' : 'close'}',
        null,
      ),
    ),
  );

  Future<IssueComment> addComment(
    String projectId,
    int number,
    String bodyMd,
  ) async => IssueComment.fromJson(
    _object(
      await _post(
        '${AuthConfig.projectIssueUrlOf(baseUrl, projectId, number)}/comments',
        {'bodyMd': bodyMd},
      ),
    ),
  );

  Future<List<Discussion>> listDiscussions(String teamId) async {
    final body = await _get(AuthConfig.teamDiscussionsUrlOf(baseUrl, teamId));
    return _list(body['discussions']).map(Discussion.fromJson).toList();
  }

  Future<Discussion> getDiscussion(String teamId, String id) async =>
      Discussion.fromJson(
        _object(
          await _get(AuthConfig.teamDiscussionUrlOf(baseUrl, teamId, id)),
        ),
      );

  Future<Discussion> createDiscussion(
    String teamId, {
    required String title,
    String bodyMd = '',
  }) async => Discussion.fromJson(
    _object(
      await _post(AuthConfig.teamDiscussionsUrlOf(baseUrl, teamId), {
        'title': title,
        'bodyMd': bodyMd,
      }),
    ),
  );

  Future<IssueComment> addDiscussionComment(
    String teamId,
    String id,
    String bodyMd,
  ) async => IssueComment.fromJson(
    _object(
      await _post(
        '${AuthConfig.teamDiscussionUrlOf(baseUrl, teamId, id)}/comments',
        {'bodyMd': bodyMd},
      ),
    ),
  );

  /// A single-entity response must carry an id; an empty 2xx (the row vanished
  /// between write and re-read) is reported instead of crashing on a cast.
  static Map<String, dynamic> _object(Map<String, dynamic> body) {
    if (body['id'] is! String) {
      throw const ApiException(200, '서버 응답이 비어 있습니다. 다시 시도해주세요.');
    }
    return body;
  }

  Map<String, String> get _headers => {
    'Authorization': 'Bearer $token',
    'Accept': 'application/json',
  };

  Future<Map<String, dynamic>> _get(String url) async =>
      _decode(await _client.get(Uri.parse(url), headers: _headers));

  Future<Map<String, dynamic>> _post(
    String url,
    Map<String, dynamic>? json,
  ) async => _decode(
    await _client.post(
      Uri.parse(url),
      headers: {
        ..._headers,
        if (json != null) 'Content-Type': 'application/json',
      },
      body: json == null ? null : jsonEncode(json),
    ),
  );

  Map<String, dynamic> _decode(http.Response r) {
    if (r.statusCode == 401) {
      throw UnauthorizedException('인증이 만료되었습니다. 다시 로그인해주세요.');
    }
    Map<String, dynamic>? data;
    if (r.bodyBytes.isNotEmpty) {
      try {
        final parsed = jsonDecode(utf8.decode(r.bodyBytes));
        if (parsed is Map<String, dynamic>) data = parsed;
      } catch (_) {
        data = null;
      }
    }
    if (r.statusCode >= 200 && r.statusCode < 300) {
      return data ?? const {};
    }
    final error = data?['error'];
    final code =
        error is Map<String, dynamic> ? error['code'] as String? : null;
    final serverMessage =
        error is Map<String, dynamic> && error['message'] is String
            ? error['message'] as String
            : null;
    throw ApiException(
      r.statusCode,
      describeError(r.statusCode, code, serverMessage),
      code: code,
    );
  }

  /// Korean by status/code; the server's English detail is kept in
  /// parentheses so validation messages (limits, enum values) stay visible.
  static String describeError(int status, String? code, String? detail) {
    final base = switch (code ?? status) {
      'forbidden' || 403 => '권한이 없습니다. 팀 승인 여부를 확인해주세요.',
      'not_found' || 404 => '찾을 수 없습니다.',
      'conflict' || 409 => '요청이 현재 상태와 충돌합니다.',
      'rate_limited' || 429 => '요청이 너무 잦습니다. 잠시 후 다시 시도해주세요.',
      'bad_request' || 400 => '입력값이 올바르지 않습니다.',
      _ => '요청 실패: $status',
    };
    return detail == null || detail.isEmpty ? base : '$base ($detail)';
  }

  static List<Map<String, dynamic>> _list(Object? v) =>
      ((v as List<dynamic>?) ?? const []).cast<Map<String, dynamic>>();
}
