import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:share_plus/share_plus.dart';
import 'package:yyt_console/artifact_info.dart';
import 'package:yyt_console/fetch_remote_apps.dart' show UnauthorizedException;
import 'package:yyt_console/format_time.dart';
import 'package:yyt_console/projects/projects_api.dart';
import 'package:yyt_console/share/share_models.dart';

/// Hands [text] to the system share sheet (KakaoTalk, LINE, Slack, X — no
/// vendor SDK, decision #7). [origin] anchors the popover on an iPad.
typedef ShareTextFn = Future<void> Function(String text, Rect? origin);

Future<void> shareTextWithSystem(String text, Rect? origin) async {
  await SharePlus.instance.share(
    ShareParams(text: text, sharePositionOrigin: origin),
  );
}

/// The app detail screen's share action: the public link when the listing
/// is public, and a new token link for a member who may create one.
Future<void> showAppShareSheet({
  required BuildContext context,
  required ProjectsApi api,
  required String appId,
  required String title,
  required String version,
  required bool canCreate,
  List<ArtifactInfo> artifacts = const [],
  bool seatless = false,
  VoidCallback? onUnauthorized,
  ShareTextFn share = shareTextWithSystem,
}) => showModalBottomSheet<void>(
  context: context,
  isScrollControlled: true,
  showDragHandle: true,
  builder: (_) => AppShareSheet(
    api: api,
    appId: appId,
    title: title,
    version: version,
    canCreate: canCreate,
    artifacts: artifacts,
    seatless: seatless,
    onUnauthorized: onUnauthorized,
    share: share,
  ),
);

class AppShareSheet extends StatefulWidget {
  const AppShareSheet({
    super.key,
    required this.api,
    required this.appId,
    required this.title,
    required this.version,
    required this.canCreate,
    this.artifacts = const [],
    this.seatless = false,
    this.onUnauthorized,
    this.share = shareTextWithSystem,
  });

  final ProjectsApi api;
  final String appId;
  final String title;
  final String version;

  /// May create a token link (the listing panel's `canPublish`).
  final bool canCreate;

  /// The detail screen's loaded builds, for the build-kind choice.
  final List<ArtifactInfo> artifacts;

  /// A platform admin with no seat in the team: asks for a reason.
  final bool seatless;
  final VoidCallback? onUnauthorized;
  final ShareTextFn share;

  @override
  State<AppShareSheet> createState() => _AppShareSheetState();
}

class _AppShareSheetState extends State<AppShareSheet> {
  bool _loading = true;
  String? _loadError;
  String? _publicUrl;
  int _limit = 20;

  int _days = shareLinkDefaultExpiryDays;
  final _label = TextEditingController();
  final _title = TextEditingController();
  final _summary = TextEditingController();
  final _reason = TextEditingController();
  String _kind = '';
  bool _creating = false;
  // Counted in UTF-16 code units like the server's zod `.max()`.
  bool get _labelTooLong => _label.text.length > shareLinkLabelMaxLength;
  bool get _titleTooLong => _title.text.trim().length > shareLinkTitleMaxLength;
  bool get _summaryTooLong =>
      _summary.text.trim().length > shareLinkSummaryMaxLength;
  bool get _reasonMissing => widget.seatless && _reason.text.trim().isEmpty;
  bool get _reasonTooLong =>
      _reason.text.trim().length > shareLinkReasonMaxLength;
  // The server refuses control and format characters (bidi overrides,
  // zero-width joiners) in a title: messenger previews show it.
  static final _controlOrFormat = RegExp(r'[\p{Cc}\p{Cf}]', unicode: true);
  bool get _titleBadChars => _controlOrFormat.hasMatch(_title.text.trim());
  bool get _blocked =>
      _labelTooLong ||
      _titleTooLong ||
      _titleBadChars ||
      _summaryTooLong ||
      _reasonMissing ||
      _reasonTooLong;
  String? _createError;
  ShareLinkView? _created;
  String? _note;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _label.dispose();
    _title.dispose();
    _summary.dispose();
    _reason.dispose();
    super.dispose();
  }

  void _unauthorized() {
    widget.onUnauthorized?.call();
    if (mounted) Navigator.of(context).maybePop();
  }

  Future<void> _load() async {
    try {
      final view = await widget.api.listShareLinks(widget.appId);
      if (!mounted) return;
      setState(() {
        _publicUrl = view.publicUrl;
        _limit = view.limit;
        _loading = false;
      });
    } on UnauthorizedException {
      _unauthorized();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _loadError = e is ApiException && e.status == 404
            ? '이 콘솔 서버는 아직 공유 링크를 지원하지 않습니다.'
            : '공유 링크 정보를 불러오지 못했습니다: $e';
      });
    }
  }

  Future<void> _create(Rect? origin) async {
    if (_creating) return;
    setState(() {
      _creating = true;
      _createError = null;
      _note = null;
    });
    try {
      final link = await widget.api.createShareLink(
        widget.appId,
        expiresInDays: _days,
        label: _label.text,
        buildKind: _kind,
        title: _title.text,
        summary: _summary.text,
        reason: widget.seatless ? _reason.text : null,
      );
      if (!mounted) return;
      setState(() {
        _created = link;
        _creating = false;
      });
      await _share(link.url!, origin);
    } on UnauthorizedException {
      _unauthorized();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _creating = false;
        _createError = e is ApiException && e.status == 409
            ? '유효한 공유 링크는 앱마다 최대 $_limit개입니다. 콘솔에서 기존 링크를 회수한 뒤 다시 시도해주세요.'
            : '링크를 만들지 못했습니다: $e';
      });
    }
  }

  Future<void> _share(String url, Rect? origin) async {
    try {
      await widget.share(
        shareMessage(widget.title, widget.version, url),
        origin,
      );
    } catch (e) {
      if (mounted) setState(() => _note = '공유 화면을 열지 못했습니다: $e');
    }
  }

  Future<void> _copy(String url) async {
    await Clipboard.setData(ClipboardData(text: url));
    if (mounted) setState(() => _note = '링크를 복사했습니다.');
  }

  /// The button's rectangle, for the iPad share popover.
  static Rect? _originOf(BuildContext context) {
    final box = context.findRenderObject();
    if (box is! RenderBox || !box.hasSize) return null;
    return box.localToGlobal(Offset.zero) & box.size;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final bottom = MediaQuery.viewInsetsOf(context).bottom;
    return SafeArea(
      child: SingleChildScrollView(
        padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + bottom),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('공유', style: theme.textTheme.titleLarge),
            const SizedBox(height: 4),
            Text(
              '받은 사람은 로그인 없이 최신 빌드를 설치할 수 있습니다.',
              style: theme.textTheme.bodySmall,
            ),
            const SizedBox(height: 16),
            if (_loading) const LinearProgressIndicator(),
            if (_loadError case final e?)
              Text(e, style: TextStyle(color: theme.colorScheme.error)),
            if (_publicUrl case final url?) ...[
              Text('공개 링크', style: theme.textTheme.titleSmall),
              const SizedBox(height: 4),
              SelectableText(url, style: theme.textTheme.bodySmall),
              const SizedBox(height: 8),
              _linkActions(url, shareLabel: '공개 링크 공유'),
              const SizedBox(height: 16),
            ],
            if (widget.canCreate) ..._createSection(theme),
            if (!_loading && _publicUrl == null && !widget.canCreate)
              const Text('공유할 수 있는 링크가 없습니다. 팀 멤버가 링크를 만들 수 있습니다.'),
            if (_note case final n?) ...[
              const SizedBox(height: 12),
              Text(n, style: theme.textTheme.bodySmall),
            ],
          ],
        ),
      ),
    );
  }

  Widget _linkActions(String url, {required String shareLabel}) => Wrap(
    spacing: 8,
    runSpacing: 8,
    children: [
      Builder(
        builder: (bctx) => FilledButton.icon(
          onPressed: () => _share(url, _originOf(bctx)),
          icon: const Icon(Icons.share_rounded),
          label: Text(shareLabel),
        ),
      ),
      OutlinedButton.icon(
        onPressed: () => _copy(url),
        icon: const Icon(Icons.copy_rounded),
        label: const Text('링크 복사'),
      ),
    ],
  );

  List<Widget> _createSection(ThemeData theme) {
    final created = _created;
    if (created != null) {
      final expires = created.expiresAt;
      return [
        Text('새 링크', style: theme.textTheme.titleSmall),
        const SizedBox(height: 4),
        SelectableText(created.url!, style: theme.textTheme.bodySmall),
        if (expires != null)
          Text(
            '${formatLocalTime(expires)} 까지 유효',
            style: theme.textTheme.bodySmall,
          ),
        const SizedBox(height: 4),
        Text(
          '이 링크는 지금만 표시됩니다. 닫기 전에 공유하거나 복사하세요.',
          style: theme.textTheme.bodySmall,
        ),
        const SizedBox(height: 8),
        _linkActions(created.url!, shareLabel: '공유'),
      ];
    }
    return [
      Text('새 링크 만들기', style: theme.textTheme.titleSmall),
      const SizedBox(height: 8),
      SegmentedButton<int>(
        segments: [
          for (final d in shareLinkExpiryDays)
            ButtonSegment<int>(value: d, label: Text('$d일')),
        ],
        selected: {_days},
        onSelectionChanged: _creating
            ? null
            : (s) => setState(() => _days = s.first),
      ),
      const SizedBox(height: 8),
      TextField(
        controller: _label,
        enabled: !_creating,
        // Counted in UTF-16 code units like the server's `.max(100)`, not
        // in graphemes as `maxLength` would.
        onChanged: (_) => setState(() {}),
        decoration: InputDecoration(
          labelText: '메모 (선택)',
          helperText: '팀에게만 보입니다. 받는 사람에게는 보이지 않습니다.',
          counterText: '${_label.text.length}/$shareLinkLabelMaxLength',
          errorText: _labelTooLong
              ? '메모는 $shareLinkLabelMaxLength자 이하로 입력하세요.'
              : null,
        ),
      ),
      const SizedBox(height: 8),
      DropdownButtonFormField<String>(
        initialValue: _kind,
        decoration: const InputDecoration(labelText: '빌드'),
        items: [
          const DropdownMenuItem(value: '', child: Text('플랫폼별 최신 빌드')),
          for (final k in availableShareKinds(widget.artifacts))
            DropdownMenuItem(value: k, child: Text(shareBuildKindLabels[k]!)),
        ],
        onChanged: _creating ? null : (v) => setState(() => _kind = v ?? ''),
      ),
      const SizedBox(height: 8),
      TextField(
        controller: _title,
        enabled: !_creating,
        onChanged: (_) => setState(() {}),
        decoration: InputDecoration(
          labelText: '링크 제목 (선택)',
          helperText: '받는 사람에게 앱 이름 대신 보입니다.',
          errorText: _titleTooLong
              ? '제목은 $shareLinkTitleMaxLength자 이하로 입력하세요.'
              : _titleBadChars
              ? '제목에 제어 문자나 서식 문자(이모지 결합 문자 등)는 쓸 수 없습니다.'
              : null,
        ),
      ),
      const SizedBox(height: 8),
      TextField(
        controller: _summary,
        enabled: !_creating,
        minLines: 2,
        maxLines: 6,
        onChanged: (_) => setState(() {}),
        decoration: InputDecoration(
          labelText: '링크 소개 (선택)',
          helperText: '설치 페이지에 보입니다.',
          errorText: _summaryTooLong
              ? '소개는 $shareLinkSummaryMaxLength자 이하로 입력하세요.'
              : null,
        ),
      ),
      if (widget.seatless) ...[
        const SizedBox(height: 8),
        TextField(
          controller: _reason,
          enabled: !_creating,
          onChanged: (_) => setState(() {}),
          decoration: InputDecoration(
            labelText: '사유 (필수)',
            helperText: '이 팀의 좌석이 없는 관리자입니다. 사유는 감사 기록에 남습니다.',
            // UTF-16 units, like the server's `.max(500)`.
            counterText:
                '${_reason.text.trim().length}/$shareLinkReasonMaxLength',
            errorText: _reasonTooLong
                ? '사유는 $shareLinkReasonMaxLength자 이하로 입력하세요.'
                : null,
          ),
        ),
      ],
      const SizedBox(height: 8),
      if (_createError case final e?) ...[
        Text(e, style: TextStyle(color: theme.colorScheme.error)),
        const SizedBox(height: 8),
      ],
      Builder(
        builder: (bctx) => FilledButton.icon(
          onPressed: _creating || _blocked
              ? null
              : () => _create(_originOf(bctx)),
          icon: _creating
              ? const SizedBox.square(
                  dimension: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.add_link_rounded),
          label: const Text('새 링크 만들기'),
        ),
      ),
    ];
  }
}
