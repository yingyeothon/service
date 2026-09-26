import 'package:yyt_console/projects/models.dart';

/// Channels (services/console/src/channels.ts `channelView` + crumbs). The
/// view never carries secrets; the one-time credential of a create response
/// lives only in [CreatedChannel].
String? _str(Object? v) => v is String && v.isNotEmpty ? v : null;

Map<String, String> _stringMap(Object? v) => {
  if (v is Map)
    for (final e in v.entries)
      if (e.key is String && e.value is String)
        e.key as String: e.value as String,
};

const channelKinds = ['auth', 'topic', 'match', 'lobby', 'q'];

/// lobby/q are served by the gateway and hold no secret at all.
bool isGatewayKind(String kind) => kind == 'lobby' || kind == 'q';

String channelKindDescription(String kind) => switch (kind) {
  'auth' => 'auth — 플레이어에게 JWT 발급 (GitHub/Google 로그인)',
  'topic' => 'topic — WebSocket 브로드캐스트 토픽',
  'match' => 'match — WebSocket 매치메이커',
  'lobby' => 'lobby — 실시간 릴레이: 이동, 채팅, 파티',
  'q' => 'q — 플레이어 소켓을 게임 Lambda에 연결',
  _ => kind,
};

String channelStatusLabel(String status) => switch (status) {
  'active' => '활성',
  'expired' => '만료',
  'disabled' => '비활성',
  _ => status,
};

class Channel {
  const Channel({
    required this.id,
    required this.kind,
    required this.name,
    required this.config,
    required this.createdAt,
    required this.expiresAt,
    required this.status,
    this.disabledAt,
    this.teamId,
    this.teamName,
    this.projectId,
    this.projectName,
    this.createdBy,
    this.issuer,
    this.saltedIds,
    this.startUrl,
    this.callbackUrls = const {},
    this.docUrl,
    this.apiBase,
    this.wsUrl,
    this.redis = const {},
  });

  final String id;

  /// `auth` | `topic` | `match` | `lobby` | `q`.
  final String kind;
  final String name;

  /// The stored config as the server returned it (never holds a secret).
  final Map<String, dynamic> config;
  final DateTime createdAt;
  final DateTime expiresAt;

  /// `active` | `expired` | `disabled`.
  final String status;
  final DateTime? disabledAt;
  final String? teamId;
  final String? teamName;
  final String? projectId;
  final String? projectName;
  final String? createdBy;

  // auth
  final String? issuer;
  final bool? saltedIds;
  final String? startUrl;
  final Map<String, String> callbackUrls;
  final String? docUrl;

  // topic
  final String? apiBase;

  // topic / match / lobby / q (absent while the gateway is not deployed)
  final String? wsUrl;

  // q: derived Redis names, copied into tslib config verbatim.
  final Map<String, String> redis;

  bool get hasSecret => !isGatewayKind(kind);

  /// The linked auth channel of a non-auth kind.
  String? get authChannelId => _str(config['authChannelId']);

  static Channel fromJson(Map<String, dynamic> j) => Channel(
    id: j['id'] as String,
    kind: (j['kind'] as String?) ?? '',
    name: (j['name'] as String?) ?? '',
    config:
        j['config'] is Map<String, dynamic>
            ? Map<String, dynamic>.unmodifiable(j['config'] as Map)
            : const {},
    createdAt: fromUnixSeconds(j['createdAt']),
    expiresAt: fromUnixSeconds(j['expiresAt']),
    status: (j['status'] as String?) ?? '',
    disabledAt:
        j['disabledAt'] is num ? fromUnixSeconds(j['disabledAt']) : null,
    teamId: _str(j['teamId']),
    teamName: _str(j['teamName']),
    projectId: _str(j['projectId']),
    projectName: _str(j['projectName']),
    createdBy: _str(j['createdBy']),
    issuer: _str(j['issuer']),
    saltedIds: j['saltedIds'] is bool ? j['saltedIds'] as bool : null,
    startUrl: _str(j['startUrl']),
    callbackUrls: _stringMap(j['callbackUrls']),
    docUrl: _str(j['docUrl']),
    apiBase: _str(j['apiBase']),
    wsUrl: _str(j['wsUrl']),
    redis: _stringMap(j['redis']),
  );

  @override
  String toString() => 'Channel($id, $kind)';
}

/// A `POST /projects/{prj}/channels` response: the view plus, for auth the
/// signing `secret` and for topic/match the `apiKey` — shown once, never
/// stored, never logged. lobby/q carry none.
class CreatedChannel {
  const CreatedChannel({required this.channel, this.credential});

  final Channel channel;
  final String? credential;

  String get credentialLabel => channel.kind == 'auth' ? '채널 시크릿' : 'API 키';

  static CreatedChannel fromJson(Map<String, dynamic> j) {
    final channel = Channel.fromJson(j);
    final credential = switch (channel.kind) {
      'auth' => _str(j['secret']),
      'topic' || 'match' => _str(j['apiKey']),
      _ => null,
    };
    return CreatedChannel(channel: channel, credential: credential);
  }

  @override
  String toString() =>
      'CreatedChannel(${channel.id}, credential: '
      '${credential == null ? 'none' : '<redacted>'})';
}
