import 'dart:convert';

import 'package:yyt_console/auth/auth_config.dart';
import 'package:yyt_console/fetch_remote_apps.dart' show UnauthorizedException;
import 'package:yyt_console/listing/listing_models.dart';
import 'package:yyt_console/projects/limit_models.dart';
import 'package:yyt_console/projects/channel_models.dart';
import 'package:yyt_console/projects/models.dart';
import 'package:yyt_console/projects/site_models.dart';
import 'package:http/http.dart' as http;

/// A console API error with the server's message (`{error:{code,message,
/// details}}`, packages/http/src/handler.ts). On a 400 `details` is the
/// validation list (`[{path, message}]`); otherwise it is an object such as
/// `{reason: "domain_taken"}` or `{retryAfterMs: 1000}`.
class ApiException implements Exception {
  const ApiException(this.status, this.message, {this.code, this.details});

  final int status;
  final String message;
  final String? code;

  /// The raw `error.details`, as sent.
  final Object? details;

  /// `details.reason` when details is an object.
  String? get reason {
    final d = details;
    return d is Map && d['reason'] is String ? d['reason'] as String : null;
  }

  /// `details.names[].name`: the team's counted names on a `domain_cap` 409
  /// (docs/decisions.md *Site domains* §7).
  List<String> get names {
    final d = details;
    final list = d is Map ? d['names'] : null;
    if (list is! List) return const [];
    return [
      for (final n in list)
        if (n is Map && n['name'] is String) n['name'] as String,
    ];
  }

  /// `details.{limit, value, usage, next}` of a refused write or a refused
  /// limit request (docs/decisions.md *Limit requests* #2); `null` otherwise.
  Map<String, Object?>? get limitDetails {
    final d = details;
    if (d is! Map || d['limit'] is! String) return null;
    return {
      'limit': d['limit'],
      'value': d['value'],
      'usage': d['usage'],
      'next': d['next'],
    };
  }

  /// `details.retryAt` of a 429 (the 7-day cooldown), as a UTC instant.
  DateTime? get retryAt {
    final d = details;
    final at = d is Map ? d['retryAt'] : null;
    return at is num
        ? DateTime.fromMillisecondsSinceEpoch(at.toInt() * 1000, isUtc: true)
        : null;
  }

  /// `path → message` from a validation list; the first message per path.
  Map<String, String> get fieldErrors {
    final d = details;
    if (d is! List) return const {};
    final out = <String, String>{};
    for (final item in d) {
      if (item is! Map) continue;
      final path = item['path'];
      final message = item['message'];
      if (path is String && message is String) {
        out.putIfAbsent(path, () => message);
      }
    }
    return out;
  }

  @override
  String toString() => message;
}

/// Teams → projects → issues → comments, team discussions, and a project's
/// sites and channels, over the console API. Every call carries the saved
/// token; 401 surfaces as [UnauthorizedException] so the caller logs out like
/// the app list does.
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

  /// Every project of the team, most recently touched first (server order);
  /// [limit] caps the page. A console older than the route answers 404
  /// `not_found`; [listTeamIssuesCompat] walks the projects instead.
  Future<List<Issue>> listTeamIssues(
    String teamId, {
    String? status,
    int? limit,
  }) async {
    final query = {
      if (status != null) 'status': status,
      if (limit != null) 'limit': '$limit',
    };
    final base = AuthConfig.teamIssuesUrlOf(baseUrl, teamId);
    final url =
        query.isEmpty
            ? base
            : Uri.parse(base).replace(queryParameters: query).toString();
    final body = await _get(url);
    return _list(body['issues']).map(Issue.fromJson).toList();
  }

  /// [listTeamIssues], falling back to one `/projects/{id}/issues` call per
  /// project (sorted here by `updatedAt`) when the server predates the
  /// team route, so a new app against an old console still shows the feed.
  Future<List<Issue>> listTeamIssuesCompat(
    String teamId,
    List<Project> projects, {
    String? status,
    int? limit,
  }) async {
    try {
      return await listTeamIssues(teamId, status: status, limit: limit);
    } on ApiException catch (e) {
      if (e.status != 404) rethrow;
    }
    final perProject = await Future.wait([
      for (final p in projects) listIssues(p.id, status: status),
    ]);
    final all =
        perProject.expand((l) => l).toList()
          ..sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
    return limit == null ? all : all.take(limit).toList();
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

  // ---- sites ------------------------------------------------------------

  Future<List<Site>> listSites(String projectId) async {
    final body = await _get(AuthConfig.projectSitesUrlOf(baseUrl, projectId));
    return _list(body['sites']).map(Site.fromJson).toList();
  }

  Future<SiteDetail> getSite(String id) async => SiteDetail.fromJson(
    _object(await _get(AuthConfig.siteUrlOf(baseUrl, id))),
  );

  /// A blank description is left out rather than sent empty.
  Future<Site> createSite(
    String projectId, {
    required String name,
    String description = '',
  }) async {
    final d = description.trim();
    return Site.fromJson(
      _object(
        await _post(AuthConfig.projectSitesUrlOf(baseUrl, projectId), {
          'name': name.trim(),
          if (d.isNotEmpty) 'description': d,
        }),
      ),
    );
  }

  /// [patch] carries only the changed keys ([buildSitePatch]). A 202 means a
  /// rename queued a move: the view is `busy` with `movingTo` until the
  /// worker finishes.
  Future<SiteUpdate> updateSite(String id, Map<String, Object?> patch) async {
    final r = await _patch(AuthConfig.siteUrlOf(baseUrl, id), patch);
    final body = _object(_decode(r));
    return SiteUpdate(
      site: Site.fromJson(body),
      moveQueued: r.statusCode == 202,
    );
  }

  Future<void> deleteSite(String id) =>
      _delete(AuthConfig.siteUrlOf(baseUrl, id));

  // ---- channels ---------------------------------------------------------

  /// [kind] narrows the list (`auth` for the auth-channel picker).
  Future<List<Channel>> listChannels(String projectId, {String? kind}) async {
    final base = AuthConfig.projectChannelsUrlOf(baseUrl, projectId);
    final url =
        kind == null
            ? base
            : Uri.parse(
              base,
            ).replace(queryParameters: {'kind': kind}).toString();
    final body = await _get(url);
    return _list(body['channels']).map(Channel.fromJson).toList();
  }

  Future<Channel> getChannel(String id) async => Channel.fromJson(
    _object(await _get(AuthConfig.channelUrlOf(baseUrl, id))),
  );

  /// The response is the only place the credential ever appears.
  Future<CreatedChannel> createChannel(
    String projectId, {
    required String kind,
    required String name,
    required Object config,
  }) async => CreatedChannel.fromJson(
    _object(
      await _post(AuthConfig.projectChannelsUrlOf(baseUrl, projectId), {
        'kind': kind,
        'name': name,
        'config': config,
      }),
    ),
  );

  /// Sends only what is given; the server keeps what is left out.
  Future<Channel> updateChannel(
    String id, {
    String? name,
    Object? config,
  }) async {
    final r = await _patch(AuthConfig.channelUrlOf(baseUrl, id), {
      if (name != null) 'name': name,
      if (config != null) 'config': config,
    });
    return Channel.fromJson(_object(_decode(r)));
  }

  /// +7 days, capped at 28 days ahead; a channel already at the cap is 409.
  Future<Channel> extendChannel(String id) async => Channel.fromJson(
    _object(await _post(AuthConfig.channelExtendUrlOf(baseUrl, id), null)),
  );

  Future<void> deleteChannel(String id) =>
      _delete(AuthConfig.channelUrlOf(baseUrl, id));

  // ---- catalog listings (docs/decisions.md *Catalog listings*) ----------

  /// The app's listing, or null when it is not published (404). Any other
  /// failure (a viewer's 404 is indistinguishable and means the same) is
  /// thrown as usual.
  Future<CatalogListing?> getListing(String appId) async {
    try {
      return CatalogListing.fromJson(
        await _get(AuthConfig.appListingUrlOf(baseUrl, appId)),
      );
    } on ApiException catch (e) {
      if (e.status == 404) return null;
      rethrow;
    }
  }

  // ---- limits (docs/decisions.md *Limit requests (soft/hard)*) -------------

  /// `GET /limits?scope=<kind>:<id>`: the scope's rows and pending requests.
  Future<LimitsView> getLimits(String kind, String id) async =>
      LimitsView.fromJson(
        await _get(AuthConfig.limitsUrlOf(baseUrl, '$kind:$id')),
      );

  /// `POST /limit-requests`; [value] `null` asks for unlimited. A stepped key
  /// below its limit, or any value but `next`, is a 400 whose
  /// [ApiException.limitDetails] say why; a cooldown is a 429 with
  /// [ApiException.retryAt].
  Future<LimitRequest> createLimitRequest({
    required String kind,
    required String id,
    required String key,
    required int? value,
    required String reason,
  }) async => LimitRequest.fromJson(
    _object(
      await _post(AuthConfig.limitRequestsUrlOf(baseUrl), {
        'scope': '$kind:$id',
        'key': key,
        'value': limitValueWire(value),
        'reason': reason,
      }),
    ),
  );

  /// The team's requests, newest first (one page). No screen lists them yet;
  /// the card shows a scope's pending ones from `getLimits`.
  Future<List<LimitRequest>> listLimitRequests(
    String teamId, {
    String? status,
  }) async {
    final q = {'team': teamId, if (status != null) 'status': status};
    final url = Uri.parse(
      AuthConfig.limitRequestsUrlOf(baseUrl),
    ).replace(queryParameters: q).toString();
    final body = await _get(url);
    return [
      for (final r in (body['requests'] as List?) ?? const [])
        if (r is Map<String, dynamic>) LimitRequest.fromJson(r),
    ];
  }

  /// The requester, while still seated, or a team owner cancels a pending one.
  Future<LimitRequest> cancelLimitRequest(String id) async =>
      LimitRequest.fromJson(
        _object(
          await _post(
            '${AuthConfig.limitRequestUrlOf(baseUrl, id)}/cancel',
            null,
          ),
        ),
      );

  /// Publish (201) or edit (200) the listing; a takedown answers 409 with
  /// `details.reason` `taken_down` when no listing row exists.
  Future<CatalogListing> publishListing(
    String appId,
    Map<String, Object?> body,
  ) async => CatalogListing.fromJson(
    await _put(AuthConfig.appListingUrlOf(baseUrl, appId), body),
  );

  Future<void> unpublishListing(String appId) =>
      _delete(AuthConfig.appListingUrlOf(baseUrl, appId));

  Future<List<ListingViewer>> listListingViewers(String appId) async {
    final body = await _get(AuthConfig.appListingViewersUrlOf(baseUrl, appId));
    return _list(body['viewers']).map(ListingViewer.fromJson).toList();
  }

  /// Names a platform member by GitHub login; an unknown or still-pending
  /// login is a 404, the cap a 409.
  Future<ListingViewerAdded> addListingViewer(
    String appId,
    String login,
  ) async {
    final body = await _post(
      AuthConfig.appListingViewersUrlOf(baseUrl, appId),
      {'login': login},
    );
    return ListingViewerAdded(
      login: (body['login'] as String?) ?? login,
      added: body['added'] == true,
    );
  }

  Future<void> removeListingViewer(String appId, String login) =>
      _delete(AuthConfig.appListingViewerUrlOf(baseUrl, appId, login));

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

  Future<Map<String, dynamic>> _put(
    String url,
    Map<String, Object?> json,
  ) async => _decode(
    await _client.put(
      Uri.parse(url),
      headers: {..._headers, 'Content-Type': 'application/json'},
      body: jsonEncode(json),
    ),
  );

  /// The raw response: the caller decodes it, and a site rename's 202 is
  /// read from the status.
  Future<http.Response> _patch(String url, Map<String, Object?> json) =>
      _client.patch(
        Uri.parse(url),
        headers: {..._headers, 'Content-Type': 'application/json'},
        body: jsonEncode(json),
      );

  /// DELETE answers 204 with an empty body: checked for errors, never read
  /// as an entity.
  Future<void> _delete(String url) async {
    _decode(await _client.delete(Uri.parse(url), headers: _headers));
  }

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
        error is Map<String, dynamic> && error['code'] is String
            ? error['code'] as String
            : null;
    final serverMessage =
        error is Map<String, dynamic> && error['message'] is String
            ? error['message'] as String
            : null;
    final details = error is Map<String, dynamic> ? error['details'] : null;
    final partial = ApiException(
      r.statusCode,
      '',
      code: code,
      details: details,
    );
    final fields = partial.fieldErrors.entries.map(
      (e) => e.key.isEmpty ? e.value : '${e.key}: ${e.value}',
    );
    final base = describeError(
      r.statusCode,
      code,
      serverMessage,
      reason: partial.reason,
    );
    throw ApiException(
      r.statusCode,
      fields.isEmpty ? base : '$base — ${fields.join('; ')}',
      code: code,
      details: details,
    );
  }

  static const _reasonMessages = {
    'domain_taken': '이미 쓰이고 있거나 다른 팀이 쓴 적 있는 이름입니다.',
    'domain_cap': '팀의 이름 한도(20개)에 도달했습니다.',
    'domain_cleaning': '이 이름은 아직 정리 중입니다. 잠시 뒤 다시 시도하세요.',
    'taken_down': '플랫폼 관리자가 내린 게시입니다. 관리자가 해제하기 전에는 다시 게시할 수 없습니다.',
  };

  static const _codeMessages = {
    'forbidden': '권한이 없습니다. 팀 승인 여부를 확인해주세요.',
    'not_found': '찾을 수 없습니다.',
    'conflict': '요청이 현재 상태와 충돌합니다.',
    'rate_limited': '요청이 너무 잦습니다. 잠시 뒤 다시 시도하세요.',
    'bad_request': '입력값이 올바르지 않습니다.',
    'unavailable': '서버가 잠시 요청을 처리할 수 없습니다. 잠시 뒤 다시 시도하세요.',
  };

  static const _statusMessages = {
    403: '권한이 없습니다. 팀 승인 여부를 확인해주세요.',
    404: '찾을 수 없습니다.',
    409: '요청이 현재 상태와 충돌합니다.',
    429: '요청이 너무 잦습니다. 잠시 뒤 다시 시도하세요.',
    400: '입력값이 올바르지 않습니다.',
    503: '서버가 잠시 요청을 처리할 수 없습니다. 잠시 뒤 다시 시도하세요.',
  };

  /// The Korean sentence for a known `details.reason`, without the server's
  /// English detail (shown under the field the reason is about). A
  /// `domain_cap` refusal lists the team's counted [names], since reusing
  /// one of them is the way past the cap.
  static String? reasonMessage(
    String? reason, {
    List<String> names = const [],
  }) {
    final base = _reasonMessages[reason];
    if (base == null || reason != 'domain_cap' || names.isEmpty) return base;
    return '$base 세는 이름: ${names.join(', ')}. 이 중 하나를 다시 쓰면 '
        '한도에 더해지지 않고, 놓아준 이름은 30일이 지나면 빠집니다.';
  }

  /// Korean by `details.reason`, then `code`, then status; the server's
  /// English detail is kept in parentheses so validation messages (limits,
  /// enum values) stay visible.
  static String describeError(
    int status,
    String? code,
    String? detail, {
    String? reason,
  }) {
    final base =
        _reasonMessages[reason] ??
        _codeMessages[code] ??
        _statusMessages[status] ??
        '요청 실패: $status';
    return detail == null || detail.isEmpty ? base : '$base ($detail)';
  }

  static List<Map<String, dynamic>> _list(Object? v) =>
      ((v as List<dynamic>?) ?? const []).cast<Map<String, dynamic>>();
}
