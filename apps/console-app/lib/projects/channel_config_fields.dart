import 'package:yyt_console/projects/channel_config_form.dart';
import 'package:yyt_console/projects/channel_models.dart';
import 'package:yyt_console/projects/resource_widgets.dart';
import 'package:flutter/material.dart';

/// The kind-specific inputs of the channel form (the name field is the
/// screen's). Writes straight into [form] and calls [onChanged]; the labels
/// follow apps/console-web/src/components/ChannelForm.tsx.
class ChannelConfigFields extends StatefulWidget {
  const ChannelConfigFields({
    super.key,
    required this.kind,
    required this.form,
    required this.authChannels,
    required this.onChanged,
    this.storedProviders = const {},
  });

  final String kind;
  final ChannelFormState form;

  /// The project's auth channels for the picker; null while loading.
  final List<Channel>? authChannels;
  final VoidCallback onChanged;

  /// Providers the edited auth channel already has: their secret may stay
  /// blank to keep the stored one.
  final Set<String> storedProviders;

  @override
  State<ChannelConfigFields> createState() => _ChannelConfigFieldsState();
}

class _ChannelConfigFieldsState extends State<ChannelConfigFields> {
  final _controllers = <String, TextEditingController>{};

  ChannelFormState get f => widget.form;

  @override
  void dispose() {
    for (final c in _controllers.values) {
      c.dispose();
    }
    super.dispose();
  }

  void _set(VoidCallback write) {
    write();
    widget.onChanged();
  }

  Widget _text(
    String key, {
    required String label,
    required String value,
    required ValueChanged<String> onChanged,
    String? helper,
    String? hint,
    bool number = false,
    int? maxLength,
    int minLines = 1,
    int maxLines = 1,
    bool enabled = true,
  }) {
    final controller = _controllers.putIfAbsent(
      key,
      () => TextEditingController(text: value),
    );
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: TextField(
        key: ValueKey('field-$key'),
        controller: controller,
        enabled: enabled,
        keyboardType:
            number
                ? TextInputType.number
                : maxLines > 1
                ? TextInputType.multiline
                : TextInputType.text,
        maxLength: maxLength,
        minLines: minLines,
        maxLines: maxLines,
        decoration: InputDecoration(
          labelText: label,
          helperText: helper,
          helperMaxLines: 4,
          hintText: hint,
        ),
        onChanged: (v) => _set(() => onChanged(v)),
      ),
    );
  }

  /// A provider client secret: never suggested, learned or shown.
  Widget _secret(
    String key, {
    required String label,
    required String value,
    required ValueChanged<String> onChanged,
    String? hint,
  }) {
    final controller = _controllers.putIfAbsent(
      key,
      () => TextEditingController(text: value),
    );
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: TextField(
        key: ValueKey('field-$key'),
        controller: controller,
        obscureText: true,
        enableSuggestions: false,
        autocorrect: false,
        enableIMEPersonalizedLearning: false,
        keyboardType: TextInputType.visiblePassword,
        decoration: InputDecoration(labelText: label, hintText: hint),
        onChanged: (v) => _set(() => onChanged(v)),
      ),
    );
  }

  Widget _authPicker() {
    final auths = widget.authChannels ?? const <Channel>[];
    final current = f.authChannelId;
    final known = auths.any((c) => c.id == current);
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: DropdownButtonFormField<String>(
        key: ValueKey('auth-picker-${auths.length}'),
        initialValue: current,
        isExpanded: true,
        decoration: InputDecoration(
          labelText: '인증 채널',
          helperText:
              widget.authChannels == null
                  ? '인증 채널을 불러오는 중…'
                  : '플레이어는 이 인증 채널이 발급한 JWT로 접속합니다.',
        ),
        items: [
          const DropdownMenuItem(value: '', child: Text('— 선택 —')),
          for (final c in auths)
            DropdownMenuItem(
              value: c.id,
              child: Text(
                '${c.name} (${c.id})',
                overflow: TextOverflow.ellipsis,
              ),
            ),
          // A link to a channel not in the list (deleted, or another
          // project's) stays selectable so an edit does not silently drop it.
          if (current.isNotEmpty && !known)
            DropdownMenuItem(
              value: current,
              child: Text(
                '(목록에 없음) ($current)',
                overflow: TextOverflow.ellipsis,
              ),
            ),
        ],
        onChanged: (v) => _set(() => f.authChannelId = v ?? ''),
      ),
    );
  }

  Widget _check(String label, bool value, ValueChanged<bool> onChanged) =>
      CheckboxListTile(
        dense: true,
        contentPadding: EdgeInsets.zero,
        controlAffinity: ListTileControlAffinity.leading,
        title: Text(label),
        value: value,
        onChanged: (v) => _set(() => onChanged(v ?? false)),
      );

  @override
  Widget build(BuildContext context) {
    return switch (widget.kind) {
      'auth' => _auth(),
      'topic' => _authPicker(),
      'q' => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _authPicker(),
          const HintText(
            '이 채널이 쓰는 Redis 키 접두사는 채널 id에서 정해지며, 만든 뒤 채널 화면에 '
            '나옵니다. 게임 Lambda의 tslib 설정에 그대로 복사하세요 — 한쪽이라도 '
            '다르면 조용히 실패합니다.',
          ),
        ],
      ),
      'lobby' => _lobby(),
      'match' => _match(),
      _ => const SizedBox.shrink(),
    };
  }

  Widget _auth() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _text(
          'audience',
          label: '오디언스 (JWT aud)',
          value: f.audience,
          hint: 'my-game',
          maxLength: 200,
          onChanged: (v) => f.audience = v,
        ),
        _text(
          'tokenTtlSec',
          label: '토큰 TTL (초)',
          value: f.tokenTtlSec,
          number: true,
          onChanged: (v) => f.tokenTtlSec = v,
        ),
        _text(
          'redirectAllowlist',
          label: '리다이렉트 허용 목록 (한 줄에 절대 https URL 하나, 최대 20개)',
          value: f.redirectAllowlist,
          helper: '로그인 뒤에는 이 URL 중 하나로 시작하는 곳으로만 돌아갑니다 (origin + 경로 경계).',
          hint: 'https://game.example.com/callback',
          minLines: 2,
          maxLines: 6,
          onChanged: (v) => f.redirectAllowlist = v,
        ),
        for (final p in const ['github', 'google']) _provider(p),
      ],
    );
  }

  Widget _provider(String p) {
    final github = p == 'github';
    final enabled = github ? f.githubEnabled : f.googleEnabled;
    final stored = widget.storedProviders.contains(p);
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      color: Theme.of(context).colorScheme.surfaceContainerLowest,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(8, 0, 8, 4),
        child: Column(
          children: [
            _check(
              github ? 'GitHub 로그인' : 'Google 로그인',
              enabled,
              (v) => github ? f.githubEnabled = v : f.googleEnabled = v,
            ),
            if (enabled) ...[
              _text(
                '${p}ClientId',
                label: '클라이언트 ID',
                value: github ? f.githubClientId : f.googleClientId,
                onChanged:
                    (v) => github ? f.githubClientId = v : f.googleClientId = v,
              ),
              _secret(
                '${p}SecretInput',
                label: '클라이언트 시크릿',
                value: github ? f.githubSecretInput : f.googleSecretInput,
                hint: stored ? '비워 두면 저장된 시크릿을 유지합니다' : null,
                onChanged:
                    (v) =>
                        github
                            ? f.githubSecretInput = v
                            : f.googleSecretInput = v,
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _lobby() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _authPicker(),
        Text('기능', style: Theme.of(context).textTheme.titleSmall),
        _check('위치 — 존 안의 이동을 입장/퇴장과 함께 릴레이', f.capPos, (v) => f.capPos = v),
        _check(
          '파티 — 만들기/초대/수락/나가기, 게임이 읽을 수 있는 명단',
          f.capParty,
          (v) => f.capParty = v,
        ),
        _check(
          '이벤트 — 게이트웨이가 읽지 않는 게임 정의 메시지 릴레이',
          f.capEvent,
          (v) => f.capEvent = v,
        ),
        _check('디버그 명령 (필요할 때만)', f.capDebug, (v) => f.capDebug = v),
        const SizedBox(height: 4),
        Text('채팅 범위', style: Theme.of(context).textTheme.titleSmall),
        const HintText('존 채팅은 위치가, 파티 채팅은 파티 기능이 필요합니다.'),
        Wrap(
          spacing: 8,
          children: [
            for (final scope in sayScopes)
              FilterChip(
                label: Text(scope),
                selected: f.capSay.contains(scope),
                onSelected:
                    (on) => _set(() {
                      final next = {...f.capSay};
                      on ? next.add(scope) : next.remove(scope);
                      f.capSay = sayScopes.where(next.contains).toList();
                    }),
              ),
          ],
        ),
        const SizedBox(height: 10),
        _text(
          'mapUrl',
          label: '맵 URL',
          value: f.mapUrl,
          helper:
              '플랫폼 CDN의 버전 고정 에셋으로, 첫 프레임에 모든 클라이언트에게 전달됩니다. '
              '여기서 바꾸는 것이 새 맵을 배포하는 방법입니다. 맵이 없으면 비워 두세요.',
          onChanged: (v) => f.mapUrl = v,
        ),
        _text(
          'defaultZone',
          label: '시작 존',
          value: f.defaultZone,
          maxLength: 64,
          helper: '접속할 때 알려 주는 존이며, 이후 존 이동은 게임 API가 정합니다.',
          onChanged: (v) => f.defaultZone = v,
        ),
        _text(
          'flushIntervalMs',
          label: '릴레이 간격 (ms, 50–2000)',
          value: f.flushIntervalMs,
          number: true,
          helper: '클라이언트가 기대할 틱이기도 합니다. 200ms가 던전과 같습니다.',
          onChanged: (v) => f.flushIntervalMs = v,
        ),
        _text(
          'maxMoveDelta',
          label: '최대 이동 거리 (타일, 1–64)',
          value: f.maxMoveDelta,
          number: true,
          helper: '한 번의 이동 메시지가 옮길 수 있는 최대 거리입니다. 지형은 검사하지 않습니다.',
          onChanged: (v) => f.maxMoveDelta = v,
        ),
        _text(
          'rateLimit',
          label: '초당 메시지 한도 (1–200)',
          value: f.rateLimit,
          number: true,
          onChanged: (v) => f.rateLimit = v,
        ),
        _text(
          'partySizeMax',
          label: '최대 파티 크기 (2–16)',
          value: f.partySizeMax,
          number: true,
          onChanged: (v) => f.partySizeMax = v,
        ),
        _text(
          'maxPeers',
          label: '보이는 플레이어 수 (1–256)',
          value: f.maxPeers,
          number: true,
          enabled: f.capPos,
          helper: '가까운 순으로 이만큼만 보입니다. 항상 적용되어 모든 프레임이 게이트웨이 한도 안에 듭니다.',
          onChanged: (v) => f.maxPeers = v,
        ),
        _text(
          'aoiRange',
          label: '시야 범위 (타일, 1–256, 비우면 존 전체)',
          value: f.aoiRange,
          number: true,
          enabled: f.capPos,
          helper: '두 축 모두 이 거리 안의 플레이어만 시야 후보가 됩니다.',
          onChanged: (v) => f.aoiRange = v,
        ),
      ],
    );
  }

  Widget _match() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _authPicker(),
        _text(
          'partySize',
          label: '파티 크기 (2–16)',
          value: f.partySize,
          number: true,
          onChanged: (v) => f.partySize = v,
        ),
        _text(
          'waitTimeoutSec',
          label: '대기 시간 (초, 5–600)',
          value: f.waitTimeoutSec,
          number: true,
          onChanged: (v) => f.waitTimeoutSec = v,
        ),
        Text('시간 초과 시', style: Theme.of(context).textTheme.titleSmall),
        const SizedBox(height: 6),
        SegmentedButton<String>(
          segments: const [
            ButtonSegment(value: 'fail', label: Text('fail — 실패 알림')),
            ButtonSegment(
              value: 'partial',
              label: Text('partial — 모인 인원으로 시작'),
            ),
          ],
          selected: {f.onTimeout},
          onSelectionChanged: (s) => _set(() => f.onTimeout = s.first),
        ),
        const SizedBox(height: 12),
        _text(
          'callbackUrl',
          label: '콜백 URL (선택)',
          value: f.callbackUrl,
          hint: 'https://dungeon.example.com/match',
          helper:
              '만들어진 파티를 채널 API 키로 서명해 이 주소로 POST합니다. 비우면 요청 없이 '
              '멤버끼리 파티 구성원을 알려 받고 방은 스스로 정합니다.',
          onChanged: (v) => f.callbackUrl = v,
        ),
        if (f.callbackUrl.trim().isEmpty)
          const HintText('콜백 없음: 멤버 전용 모드입니다. 게임 서버는 호출되지 않습니다.'),
      ],
    );
  }
}
