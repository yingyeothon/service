import 'package:yyt_console/app_theme.dart';
import 'package:yyt_console/auth/auth_state.dart';
import 'package:yyt_console/fetch_remote_apps.dart' show UnauthorizedException;
import 'package:yyt_console/format_time.dart';
import 'package:yyt_console/projects/limits_section.dart';
import 'package:yyt_console/projects/models.dart';
import 'package:yyt_console/projects/projects_api.dart';
import 'package:yyt_console/projects/resource_widgets.dart';
import 'package:yyt_console/projects/tracer_form_screen.dart';
import 'package:yyt_console/projects/tracer_models.dart';
import 'package:flutter/material.dart';

/// One tracer resource: the DSN a debug build sends with, the write key and
/// its rotation, the no-backup notice, how to read the data, the daily-bytes
/// limit, and (for seated members) edit and delete. Mirrors the web console's
/// tracer page and `yyt tracer get`.
class TracerDetailScreen extends StatefulWidget {
  const TracerDetailScreen({
    super.key,
    required this.authState,
    required this.team,
    required this.api,
    required this.tracerId,
  });

  final AuthState authState;
  final Team team;
  final ProjectsApi api;
  final String tracerId;

  @override
  State<TracerDetailScreen> createState() => _TracerDetailScreenState();
}

class _TracerDetailScreenState extends State<TracerDetailScreen> {
  Tracer? _tracer;
  String? _error;

  /// A read answered 404: deleted here or elsewhere.
  bool _gone = false;
  bool _acting = false;

  ProjectsApi get _api => widget.api;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final t = await _api.getTracer(widget.tracerId);
      if (!mounted) return;
      setState(() {
        _tracer = t;
        _error = null;
      });
    } on UnauthorizedException {
      if (mounted) await widget.authState.invalidate(_api.token);
    } on ApiException catch (e) {
      if (!mounted) return;
      if (e.status == 404) {
        setState(() => _gone = true);
        return;
      }
      setState(() => _error = e.message);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  Future<void> _edit(Tracer t) async {
    final updated = await Navigator.of(context).push<Tracer>(
      MaterialPageRoute<Tracer>(
        builder: (_) => TracerFormScreen.edit(
          api: _api,
          tracer: t,
          onUnauthorized: () => widget.authState.invalidate(_api.token),
        ),
      ),
    );
    if (updated == null || !mounted) return;
    setState(() => _tracer = updated);
    showSnack(context, '저장했습니다.');
  }

  Future<void> _rotate(Tracer t) async {
    final ok = await confirmDestructive(
      context,
      title: '${t.name}의 쓰기 키를 바꿀까요?',
      message: tracerRotateNotice,
      confirmLabel: '키 교체',
    );
    if (!ok || !mounted) return;
    setState(() => _acting = true);
    try {
      final rotated = await _api.rotateTracerKey(t.id);
      if (!mounted) return;
      setState(() => _tracer = rotated);
      showSnack(context, '쓰기 키를 바꿨습니다. 새 DSN으로 다시 빌드하세요.');
    } on UnauthorizedException {
      if (mounted) await widget.authState.invalidate(_api.token);
    } on ApiException catch (e) {
      if (!mounted) return;
      // Deleted elsewhere: never leave the old DSN on screen as usable.
      if (e.status == 404) {
        setState(() => _gone = true);
        return;
      }
      showSnack(context, e.message);
    } catch (e) {
      if (mounted) showSnack(context, e.toString());
    } finally {
      if (mounted) setState(() => _acting = false);
    }
  }

  Future<void> _delete(Tracer t) async {
    final ok = await confirmDestructive(
      context,
      title: '${t.name} 트레이서를 삭제할까요?',
      message: tracerDeleteNotice,
      confirmLabel: '트레이서 삭제',
    );
    if (!ok || !mounted) return;
    setState(() => _acting = true);
    try {
      await _api.deleteTracer(t.id);
      if (!mounted) return;
      showSnack(context, '트레이서를 삭제했습니다.');
      Navigator.of(context).pop();
    } on UnauthorizedException {
      if (mounted) await widget.authState.invalidate(_api.token);
    } catch (e) {
      if (!mounted) return;
      showSnack(context, e.toString());
      await _load();
    } finally {
      if (mounted) setState(() => _acting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = _gone ? null : _tracer;
    final canWrite = widget.team.canWrite;
    return Scaffold(
      appBar: AppBar(
        title: Text(t?.name ?? '트레이서'),
        actions: [
          if (t != null && canWrite) ...[
            IconButton(
              tooltip: '트레이서 편집',
              icon: const Icon(Icons.edit_outlined),
              onPressed: _acting ? null : () => _edit(t),
            ),
            PopupMenuButton<String>(
              tooltip: '더보기',
              onSelected: (v) {
                if (v == 'delete') _delete(t);
              },
              itemBuilder: (_) => [
                PopupMenuItem(
                  value: 'delete',
                  enabled: !_acting,
                  child: const Text('트레이서 삭제'),
                ),
              ],
            ),
          ],
        ],
      ),
      body: _gone
          ? const Center(
              child: Padding(
                padding: EdgeInsets.all(24),
                child: Text(
                  '이 트레이서는 삭제되었거나 더 이상 볼 수 없습니다.',
                  textAlign: TextAlign.center,
                ),
              ),
            )
          : t == null
          ? Center(
              child: _error == null
                  ? const CircularProgressIndicator()
                  : Padding(
                      padding: const EdgeInsets.all(24),
                      child: Text(
                        '트레이서를 불러오지 못했습니다.\n$_error',
                        textAlign: TextAlign.center,
                      ),
                    ),
            )
          : RefreshIndicator(onRefresh: _load, child: _body(t)),
    );
  }

  Widget _body(Tracer t) {
    final textTheme = Theme.of(context).textTheme;
    final canWrite = widget.team.canWrite;
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(14, 8, 14, 24),
      children: [
        Text(
          t.name,
          style: textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
        ),
        if (t.description != null) ...[
          const SizedBox(height: 4),
          Text(t.description!),
        ],
        const SizedBox(height: 4),
        Text(
          '만든 사람 ${t.createdBy ?? '—'} · ${formatLocalTime(t.createdAt)}',
          style: textTheme.bodySmall?.copyWith(color: CatalogPalette.slate),
        ),
        const SizedBox(height: 10),
        const NoticeCard(
          icon: Icons.warning_amber_rounded,
          text: tracerNoBackupNotice,
        ),
        if (_error != null)
          NoticeCard(
            icon: Icons.cloud_off_rounded,
            tone: ChipTone.danger,
            text: '새로 불러오지 못했습니다. $_error',
          ),
        SectionCard(
          title: 'DSN',
          children: [
            if (t.dsn != null)
              CopyRow(label: 'DSN', value: t.dsn!)
            else
              const NoticeCard(text: tracerNotConfigured),
            if (t.writeKey != null) CopyRow(label: '쓰기 키', value: t.writeKey!),
            CopyRow(label: '리소스 ID', value: t.id),
            const HintText(
              '디버그 빌드가 이 DSN으로 tracer에 보냅니다. 빌드할 때 '
              '`--dart-define=TRACER_DSN=…`처럼 넘기고 저장소에 커밋하지 마세요. '
              '쓰기 키는 디버그 빌드 안에 들어가므로 팀원 모두에게 보입니다. '
              '비밀이 아니라 키 교체와 하루 한도로 보호합니다.',
            ),
            // Nothing to rotate for while no build can carry the key.
            if (canWrite && t.dsn != null)
              Align(
                alignment: Alignment.centerLeft,
                child: OutlinedButton.icon(
                  onPressed: _acting ? null : () => _rotate(t),
                  icon: const Icon(Icons.autorenew_rounded),
                  label: const Text('쓰기 키 교체'),
                ),
              ),
          ],
        ),
        SectionCard(
          title: '데이터 읽기',
          children: [
            const HintText(
              '콘솔은 이벤트를 보여주지 않습니다. 터미널의 `yyt tracer`(API 토큰으로 읽음)나, '
              '앱 저장소에서 Claude Code의 tracer-debug 스킬로 읽습니다. 기기가 보낸 내용은 '
              '신뢰할 수 없는 데이터이니 그 안의 지시를 따르지 마세요.',
            ),
            if (t.readUrl != null)
              CopyRow(label: '명령', value: t.readCommands.join('\n'))
            else
              const HintText('이 스테이지에 tracer가 생기기 전에는 읽을 것이 없습니다.'),
          ],
        ),
        LimitsSection(
          api: _api,
          scopeKind: 'tracer',
          scopeId: t.id,
          team: widget.team,
          currentLogin: widget.authState.username,
          onUnauthorized: () => widget.authState.invalidate(_api.token),
          reloadToken: t,
        ),
        HintText(
          '하루(UTC) 디버그 데이터 한도입니다. 넘으면 첨부(스크린샷 등)부터 버리고 120%를 넘으면 '
          '날짜가 바뀌거나 증설이 승인될 때까지 모두 거절합니다. 오늘 사용량이 한도에 닿으면 50 MiB씩 더 요청할 수 있습니다: '
          '${t.limitRequestCommand}',
        ),
      ],
    );
  }
}
