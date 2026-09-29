import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'auth_config.dart';

/// Web → app sign-in handoff (todo/49).
///
/// The console SPA's "Open app" button launches this app through a Chrome
/// `intent://` URL whose target is `https://<console host>/app-open?code=…`.
/// The code is a 120-second single-use claim the app exchanges for a
/// `yyt_` token at `POST /auth/app-handoff/exchange`; the profile is then
/// added exactly as a scanned QR would be.
///
/// The activity is exported, so any app on the device can hand it a VIEW
/// intent with any URL — the manifest filter constrains what the system
/// routes here, not what arrives. [AppHandoffLink.tryParse] therefore keeps
/// its own allowlist: a link naming another host is ignored, never followed.
class AppHandoffLink {
  /// Console hosts whose links may sign this app in.
  static const List<String> consoleHosts = <String>[
    'console.yyt.life',
    'console-dev.yyt.life',
  ];
  static final RegExp _codePattern = RegExp(r'^hoff_[0-9a-f]{32}$');

  /// `https://<host>` of the console that issued the code.
  final String server;
  final String code;

  const AppHandoffLink({required this.server, required this.code});

  /// Null for anything that is not `https://<allowed host>/app-open?code=…`.
  static AppHandoffLink? tryParse(
    Uri uri, {
    List<String> hosts = consoleHosts,
  }) {
    if (uri.scheme != 'https') return null;
    if (uri.userInfo.isNotEmpty || uri.hasPort) return null;
    if (!hosts.contains(uri.host.toLowerCase())) return null;
    if (uri.path != '/app-open') return null;
    final code = uri.queryParameters['code']?.trim() ?? '';
    if (!_codePattern.hasMatch(code)) return null;
    return AppHandoffLink(
      server: AuthConfig.normalizeServerUrl('https://${uri.host}'),
      code: code,
    );
  }

  @override
  String toString() => 'AppHandoffLink($server, code: <redacted>)';
}

/// What the exchange route answered with.
class AppHandoffResult {
  final String apiKey;
  final String tokenId;
  final String login;
  const AppHandoffResult({
    required this.apiKey,
    required this.tokenId,
    required this.login,
  });
}

class AppHandoffException implements Exception {
  final String message;
  final int? status;
  const AppHandoffException(this.message, {this.status});
  @override
  String toString() => message;
}

/// `POST {server}/auth/app-handoff/exchange` — no auth header, the code is
/// the credential. 410 means expired or already used; 403 a pending member.
Future<AppHandoffResult> exchangeAppHandoff(
  AppHandoffLink link, {
  required http.Client client,
  Duration timeout = const Duration(seconds: 10),
}) async {
  final http.Response response;
  try {
    response = await client
        .post(
          Uri.parse(AuthConfig.appHandoffExchangeUrlOf(link.server)),
          headers: const {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: jsonEncode({'code': link.code}),
        )
        .timeout(timeout);
  } on TimeoutException {
    throw const AppHandoffException('콘솔 서버가 응답하지 않습니다. 잠시 후 다시 시도해주세요.');
  } on http.ClientException catch (e) {
    throw AppHandoffException('콘솔 서버에 연결하지 못했습니다: ${e.message}');
  }
  switch (response.statusCode) {
    case 201:
      break;
    case 410:
      throw const AppHandoffException(
        '로그인 링크가 만료되었거나 이미 사용됐습니다. 콘솔에서 Open app을 다시 눌러주세요.',
        status: 410,
      );
    case 403:
      throw const AppHandoffException(
        '아직 승인되지 않은 계정입니다. 관리자 승인 후 다시 시도해주세요.',
        status: 403,
      );
    case 409:
      throw const AppHandoffException(
        'API 토큰이 너무 많습니다(최대 20개). 콘솔 > API tokens에서 정리한 뒤 다시 시도해주세요.',
        status: 409,
      );
    case 404:
      throw const AppHandoffException(
        '이 콘솔 서버는 아직 웹 → 앱 로그인을 지원하지 않습니다. QR로 로그인해주세요.',
        status: 404,
      );
    default:
      throw AppHandoffException(
        '앱 로그인 실패: ${response.statusCode}',
        status: response.statusCode,
      );
  }
  final Object? decoded;
  try {
    decoded = jsonDecode(utf8.decode(response.bodyBytes));
  } on FormatException {
    throw const AppHandoffException('앱 로그인 응답을 읽을 수 없습니다.');
  }
  final key = decoded is Map ? decoded['token'] : null;
  if (key is! String || !RegExp(r'^yyt_[0-9a-f]{48}$').hasMatch(key)) {
    throw const AppHandoffException('앱 로그인 응답에 토큰이 없습니다.');
  }
  final member = decoded is Map ? decoded['member'] : null;
  final login = member is Map ? member['login'] : null;
  final tokenId = decoded is Map ? decoded['tokenId'] : null;
  return AppHandoffResult(
    apiKey: key,
    tokenId: tokenId is String ? tokenId : '',
    login: login is String ? login : '',
  );
}

/// Revokes the token a declined handoff minted: `DELETE /tokens/{id}` with
/// the token itself as bearer (the route is owner-scoped). Best effort —
/// the token is also visible under the console's API tokens.
Future<bool> revokeHandoffToken(
  AppHandoffLink link,
  AppHandoffResult r, {
  required http.Client client,
  Duration timeout = const Duration(seconds: 10),
}) async {
  if (r.tokenId.isEmpty) return false;
  try {
    final res = await client
        .delete(
          Uri.parse(AuthConfig.tokenUrlOf(link.server, r.tokenId)),
          headers: {'Authorization': 'Bearer ${r.apiKey}'},
        )
        .timeout(timeout);
    return res.statusCode == 204;
  } on Exception {
    return false;
  }
}

/// Serialises incoming links: holds them until the app is ready, drops a
/// code that is already queued or in flight (`app_links` may emit the launch
/// link on both its initial-link and stream paths), and never runs two
/// exchanges at once. A code is forgotten once handled, so the SPA's
/// "open the app again" retry with the same code is not swallowed.
class AppHandoffQueue {
  final Future<void> Function(AppHandoffLink link) handle;
  final List<AppHandoffLink> _pending = <AppHandoffLink>[];
  final Set<String> _seen = <String>{};
  bool _ready = false;
  bool _running = false;

  AppHandoffQueue(this.handle);

  /// Ignored links (not ours) return false so the caller can log them.
  bool offer(Uri uri) {
    final link = AppHandoffLink.tryParse(uri);
    if (link == null) return false;
    if (!_seen.add(link.code)) return true;
    _pending.add(link);
    _drain();
    return true;
  }

  /// Call once the app can show dialogs and add profiles.
  void ready() {
    _ready = true;
    _drain();
  }

  Future<void> _drain() async {
    if (!_ready || _running) return;
    _running = true;
    try {
      while (_pending.isNotEmpty) {
        final link = _pending.removeAt(0);
        try {
          await handle(link);
        } finally {
          _seen.remove(link.code);
        }
      }
    } finally {
      _running = false;
    }
  }
}
