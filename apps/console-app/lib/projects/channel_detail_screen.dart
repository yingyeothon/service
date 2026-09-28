import 'dart:convert';

import 'package:yyt_console/app_theme.dart';
import 'package:yyt_console/auth/auth_state.dart';
import 'package:yyt_console/fetch_remote_apps.dart' show UnauthorizedException;
import 'package:yyt_console/format_time.dart';
import 'package:yyt_console/projects/channel_form_screen.dart';
import 'package:yyt_console/projects/channel_models.dart';
import 'package:yyt_console/projects/channels_tab.dart' show channelStatusTone;
import 'package:yyt_console/projects/models.dart';
import 'package:yyt_console/projects/projects_api.dart';
import 'package:yyt_console/projects/resource_widgets.dart';
import 'package:flutter/material.dart';

/// One channel: the endpoints a game needs per kind, the raw config, and the
/// lifecycle actions. Edit needs a seat; extend and delete are also open to
/// an unseated platform admin, as on the server
/// (apps/console-web/src/pages/ChannelDetail.tsx). Secret rotation and the
/// Redis/doc credentials stay in the web console.
class ChannelDetailScreen extends StatefulWidget {
  const ChannelDetailScreen({
    super.key,
    required this.authState,
    required this.team,
    required this.api,
    required this.channelId,
    this.onChanged,
  });

  final AuthState authState;
  final Team team;
  final ProjectsApi api;
  final String channelId;

  /// Called after an edit, extend or delete so a list can refresh.
  final VoidCallback? onChanged;

  @override
  State<ChannelDetailScreen> createState() => _ChannelDetailScreenState();
}

class _ChannelDetailScreenState extends State<ChannelDetailScreen> {
  Channel? _channel;
  String? _error;
  bool _acting = false;

  ProjectsApi get _api => widget.api;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final channel = await _api.getChannel(widget.channelId);
      if (!mounted) return;
      setState(() {
        _channel = channel;
        _error = null;
      });
    } on UnauthorizedException {
      if (mounted) await widget.authState.invalidate(_api.token);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString());
    }
  }

  Future<void> _unauthorized() => widget.authState.invalidate(_api.token);

  Future<void> _edit(Channel channel) async {
    final updated = await Navigator.of(context).push<Channel>(
      MaterialPageRoute<Channel>(
        builder:
            (_) => ChannelFormScreen.edit(
              api: _api,
              existing: channel,
              onUnauthorized: _unauthorized,
            ),
      ),
    );
    if (updated == null || !mounted) return;
    setState(() => _channel = updated);
    showSnack(context, '저장했습니다.');
    widget.onChanged?.call();
  }

  Future<void> _extend(Channel channel) async {
    setState(() => _acting = true);
    try {
      final updated = await _api.extendChannel(channel.id);
      if (!mounted) return;
      setState(() => _channel = updated);
      showSnack(context, '${formatLocalTime(updated.expiresAt)}까지 연장했습니다.');
      widget.onChanged?.call();
    } on UnauthorizedException {
      if (mounted) await _unauthorized();
    } on ApiException catch (e) {
      if (!mounted) return;
      showSnack(
        context,
        e.status == 409 ? '이미 최대 만료일(28일 뒤)까지 연장되어 있습니다.' : e.message,
      );
    } catch (e) {
      if (mounted) showSnack(context, e.toString());
    } finally {
      if (mounted) setState(() => _acting = false);
    }
  }

  String _deleteMessage(Channel c) {
    final base = '이 채널의 소켓이 모두 닫히고 자격 증명이 더 이상 동작하지 않습니다. 되돌릴 수 없습니다.';
    return switch (c.kind) {
      'auth' =>
        '$base 이 채널로 로그인한 플레이어의 문서, kv 항목, 리더보드 점수와 '
            '소셜 프로필도 함께 삭제되고, 연결된 채널은 로그인을 받을 수 없게 됩니다.',
      'q' => '$base 이 채널의 Redis 계정도 폐기됩니다.',
      _ => base,
    };
  }

  Future<void> _delete(Channel channel) async {
    final ok = await confirmDestructive(
      context,
      title: '${channel.name} 채널을 삭제할까요?',
      message: _deleteMessage(channel),
      confirmLabel: '채널 삭제',
    );
    if (!ok || !mounted) return;
    setState(() => _acting = true);
    try {
      await _api.deleteChannel(channel.id);
      if (!mounted) return;
      widget.onChanged?.call();
      showSnack(context, '채널을 삭제했습니다.');
      Navigator.of(context).pop();
    } on UnauthorizedException {
      if (mounted) await _unauthorized();
    } catch (e) {
      if (mounted) showSnack(context, e.toString());
    } finally {
      if (mounted) setState(() => _acting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = _channel;
    final team = widget.team;
    return Scaffold(
      appBar: AppBar(
        title: Text(c?.name ?? '채널'),
        actions: [
          if (c != null && team.canWrite)
            IconButton(
              tooltip: '채널 편집',
              icon: const Icon(Icons.edit_outlined),
              onPressed: _acting ? null : () => _edit(c),
            ),
          if (c != null && team.canManageChannelLifecycle)
            PopupMenuButton<String>(
              tooltip: '더보기',
              onSelected: (v) {
                if (v == 'delete') _delete(c);
              },
              itemBuilder:
                  (_) => [
                    PopupMenuItem(
                      value: 'delete',
                      enabled: !_acting,
                      child: const Text('채널 삭제'),
                    ),
                  ],
            ),
        ],
      ),
      body:
          c == null
              ? Center(
                child:
                    _error == null
                        ? const CircularProgressIndicator()
                        : Padding(
                          padding: const EdgeInsets.all(24),
                          child: Text(
                            '채널을 불러오지 못했습니다.\n$_error',
                            textAlign: TextAlign.center,
                          ),
                        ),
              )
              : RefreshIndicator(onRefresh: _load, child: _body(c)),
    );
  }

  Widget _body(Channel c) {
    final textTheme = Theme.of(context).textTheme;
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(14, 8, 14, 24),
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                c.name,
                style: textTheme.titleLarge?.copyWith(
                  fontWeight: FontWeight.w800,
                ),
              ),
            ),
            StatusChip(label: c.kind, tone: ChipTone.accent),
            const SizedBox(width: 6),
            StatusChip(
              label: channelStatusLabel(c.status),
              tone: channelStatusTone(c.status),
            ),
          ],
        ),
        const SizedBox(height: 4),
        Text(
          '만든 사람 ${c.createdBy ?? '—'} · ${formatLocalTime(c.createdAt)}\n'
          '${isNoExpiry(c.expiresAt) ? '만료 없음' : '만료 ${formatLocalTime(c.expiresAt)} (${formatRelative(c.expiresAt)})'}'
          '${c.disabledAt == null ? '' : ' · 비활성 ${formatLocalTime(c.disabledAt!)}'}',
          style: textTheme.bodySmall?.copyWith(color: CatalogPalette.slate),
        ),
        const SizedBox(height: 8),
        // A channel granted no expiry is not extended (the console answers
        // 409); an admin revokes the grant instead.
        if (widget.team.canManageChannelLifecycle && !isNoExpiry(c.expiresAt))
          Align(
            alignment: Alignment.centerLeft,
            child: FilledButton.tonalIcon(
              onPressed: _acting ? null : () => _extend(c),
              icon: const Icon(Icons.update_rounded),
              label: const Text('+7일 연장'),
            ),
          ),
        const SizedBox(height: 8),
        SectionCard(
          title: '엔드포인트',
          children: [CopyRow(label: '채널 ID', value: c.id), ..._kindDetails(c)],
        ),
        Card(
          margin: const EdgeInsets.only(bottom: 10),
          child: Theme(
            data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
            child: ExpansionTile(
              title: const Text('설정 원본 (JSON)'),
              childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
              expandedCrossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SelectableText(
                  const JsonEncoder.withIndent('  ').convert(c.config),
                  style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
                ),
              ],
            ),
          ),
        ),
        const HintText('시크릿 재발급, Redis 계정과 문서 키 발급은 웹 콘솔에서 합니다.'),
      ],
    );
  }

  List<Widget> _kindDetails(Channel c) {
    final cfg = c.config;
    final authChannel = c.authChannelId ?? '';
    switch (c.kind) {
      case 'auth':
        final providers = (cfg['providers'] as Map?)?.keys.cast<String>() ?? [];
        final allowlist =
            ((cfg['redirectAllowlist'] as List?) ?? const [])
                .whereType<String>()
                .toList();
        return [
          CopyRow(label: '발급자 (iss)', value: c.issuer ?? ''),
          CopyRow(label: '오디언스 (aud)', value: '${cfg['audience'] ?? ''}'),
          CopyRow(label: '시작 URL', value: c.startUrl ?? ''),
          for (final e in c.callbackUrls.entries)
            CopyRow(label: '${e.key} 콜백', value: e.value),
          if (c.docUrl != null) CopyRow(label: '문서 저장소 URL', value: c.docUrl!),
          if (c.saltedIds == false)
            const HintText(
              '이 채널의 플레이어 id는 솔트가 없어, 공개된 id로 원래 계정을 추적할 수 있습니다. '
              '추적할 수 없는 id가 필요하면 새 채널을 만드세요.',
            ),
          HintText(
            '토큰 TTL ${cfg['tokenTtlSec'] ?? '—'}초 · 로그인 제공자: '
            '${providers.isEmpty ? '없음 (로그인하려면 하나를 설정하세요)' : providers.join(', ')}',
          ),
          HintText(
            allowlist.isEmpty
                ? '리다이렉트 허용 목록이 비어 있어 로그인 뒤 돌아갈 곳이 없습니다.'
                : '리다이렉트 허용 목록: ${allowlist.join(', ')}',
          ),
          const HintText(
            '위 콜백 URL을 OAuth 앱에 등록하세요. 게임은 이 발급자와 오디언스로 JWT를 검증합니다.',
          ),
        ];
      case 'topic':
        return [
          CopyRow(label: 'API 기본 주소', value: c.apiBase ?? ''),
          CopyRow(label: 'WebSocket URL', value: c.wsUrl ?? ''),
          CopyRow(label: '인증 채널', value: authChannel),
          HintText(
            '토픽은 API 키를 Bearer로 붙여 POST ${c.apiBase ?? ''}/t 로 만들고, '
            '클라이언트는 플레이어 JWT로 WebSocket에 구독합니다.',
          ),
        ];
      case 'match':
        final callback = cfg['callbackUrl'];
        return [
          CopyRow(label: 'WebSocket URL', value: c.wsUrl ?? ''),
          CopyRow(label: '인증 채널', value: authChannel),
          if (callback is String && callback.isNotEmpty)
            CopyRow(label: '콜백 URL', value: callback),
          HintText(
            '파티 크기 ${cfg['partySize']} · 대기 ${cfg['waitTimeoutSec']}초 · '
            '시간 초과 시 ${cfg['onTimeout']} · 모드: '
            '${callback is String && callback.isNotEmpty ? '콜백' : '멤버 전용'}',
          ),
        ];
      case 'lobby':
        final caps = (cfg['capabilities'] as Map?) ?? const {};
        final say = ((caps['say'] as List?) ?? const []).join(', ');
        final features = [
          if (caps['pos'] == true) '위치',
          if (say.isNotEmpty) '채팅 ($say)',
          if (caps['party'] == true) '파티',
          if (caps['event'] == true) '이벤트',
          if (caps['debug'] == true) '디버그',
        ];
        final mapUrl = cfg['mapUrl'];
        return [
          if (c.wsUrl != null)
            CopyRow(label: 'WebSocket URL', value: c.wsUrl!)
          else
            const HintText('이 스테이지에는 아직 게이트웨이가 없어 WebSocket URL이 없습니다.'),
          CopyRow(label: '인증 채널', value: authChannel),
          if (mapUrl is String && mapUrl.isNotEmpty)
            CopyRow(label: '맵 URL', value: mapUrl),
          HintText('기능: ${features.isEmpty ? '없음' : features.join(' · ')}'),
          HintText(
            '시작 존 ${cfg['defaultZone']} · 릴레이 ${cfg['flushIntervalMs']}ms · '
            '플레이어당 초당 ${cfg['rateLimit']}개 · 이동 ≤ ${cfg['maxMoveDelta']} · '
            '파티 ≤ ${cfg['partySizeMax']}',
          ),
        ];
      case 'q':
        const prefixKeys = [
          'eventKeyPrefix',
          'queueKeyPrefix',
          'lockKeyPrefix',
          'awaiterKeyPrefix',
          'channelPrefix',
        ];
        final r = c.redis;
        final block = [
          for (final k in prefixKeys)
            if (r[k] != null) '$k: ${r[k]}',
        ].join('\n');
        return [
          if (c.wsUrl != null)
            CopyRow(label: 'WebSocket URL', value: c.wsUrl!)
          else
            const HintText('이 스테이지에는 아직 게이트웨이가 없어 WebSocket URL이 없습니다.'),
          CopyRow(label: '인증 채널', value: authChannel),
          if (block.isNotEmpty) ...[
            const SizedBox(height: 6),
            _PrefixBlock(text: block),
          ],
          if (r['aclKeyPattern'] != null)
            CopyRow(label: 'Redis ACL 키 패턴', value: r['aclKeyPattern']!),
          if (r['aclChannelPattern'] != null)
            CopyRow(label: 'Redis ACL 채널 패턴', value: r['aclChannelPattern']!),
          if (r['aclUsername'] != null)
            CopyRow(label: 'Redis 사용자 이름', value: r['aclUsername']!),
          const HintText(
            '게임 id는 게임의 입장 API가 정하고, 플레이어 소켓은 WebSocket URL 뒤에 '
            '&gameId=…를 붙여 접속합니다. 위 접두사 블록을 통째로 복사해 tslib 옵션에 '
            '그대로 넣으세요 — 직접 만든 접두사는 이 채널의 Redis 계정 범위를 벗어나고, '
            '한 글자만 달라도 조용히 아무것도 전달되지 않습니다.',
          ),
        ];
    }
    return const [];
  }
}

/// The q channel's tslib prefixes, copied as one block (field by field, a
/// retyped prefix is the silent failure the block exists to prevent).
class _PrefixBlock extends StatelessWidget {
  const _PrefixBlock({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(right: 8, bottom: 6),
      padding: const EdgeInsets.fromLTRB(12, 8, 4, 8),
      decoration: BoxDecoration(
        color: CatalogPalette.cloud,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'tslib 접두사 (한 블록으로 복사)',
                  style: Theme.of(
                    context,
                  ).textTheme.bodySmall?.copyWith(color: CatalogPalette.slate),
                ),
                const SizedBox(height: 4),
                Text(
                  text,
                  style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
                ),
              ],
            ),
          ),
          IconButton(
            tooltip: '접두사 전체 복사',
            icon: const Icon(Icons.copy_all_rounded),
            onPressed: () => copyWithNotice(context, '접두사 블록', text),
          ),
        ],
      ),
    );
  }
}
