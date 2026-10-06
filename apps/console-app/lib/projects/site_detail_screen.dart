import 'dart:async';

import 'package:yyt_console/app_theme.dart';
import 'package:yyt_console/auth/auth_state.dart';
import 'package:yyt_console/fetch_remote_apps.dart' show UnauthorizedException;
import 'package:yyt_console/format_bytes.dart';
import 'package:yyt_console/format_time.dart';
import 'package:yyt_console/projects/models.dart';
import 'package:yyt_console/projects/projects_api.dart';
import 'package:yyt_console/projects/resource_widgets.dart';
import 'package:yyt_console/projects/site_form_screen.dart';
import 'package:yyt_console/projects/site_models.dart';
import 'package:yyt_console/projects/sites_tab.dart' show siteStateTone;
import 'package:flutter/material.dart';

/// One site: its addresses, name, current and recent deploys, and (for
/// seated members) edit and delete. Uploads stay in the web console and the
/// CLI. While the site is busy (a deploy, a move or a delete) the screen
/// re-reads it every [pollInterval] until it settles, or until a read says
/// the site is gone (404).
class SiteDetailScreen extends StatefulWidget {
  const SiteDetailScreen({
    super.key,
    required this.authState,
    required this.team,
    required this.api,
    required this.siteId,
    this.pollInterval = const Duration(seconds: 3),
  });

  final AuthState authState;
  final Team team;
  final ProjectsApi api;
  final String siteId;
  final Duration pollInterval;

  @override
  State<SiteDetailScreen> createState() => _SiteDetailScreenState();
}

class _SiteDetailScreenState extends State<SiteDetailScreen> {
  SiteDetail? _detail;
  String? _error;

  /// A read answered 404: deleted (here or elsewhere) — nothing to poll.
  bool _gone = false;
  bool _acting = false;
  Timer? _poll;

  ProjectsApi get _api => widget.api;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    _poll?.cancel();
    try {
      final detail = await _api.getSite(widget.siteId);
      if (!mounted) return;
      setState(() {
        _detail = detail;
        _error = null;
      });
      _schedulePoll(detail.site);
    } on UnauthorizedException {
      if (mounted) await widget.authState.invalidate(_api.token);
    } on ApiException catch (e) {
      if (!mounted) return;
      if (e.status == 404) {
        setState(() => _gone = true);
        return;
      }
      _readFailed(e);
    } catch (e) {
      if (mounted) _readFailed(e);
    }
  }

  /// A failed read of a busy site keeps trying; the last known state still
  /// says it is busy.
  void _readFailed(Object e) {
    setState(() => _error = e.toString());
    final site = _detail?.site;
    if (site != null) _schedulePoll(site);
  }

  /// One read at a time: the next poll is armed only after this one lands.
  void _schedulePoll(Site site) {
    _poll?.cancel();
    if (!site.busy || _gone || !mounted) return;
    _poll = Timer(widget.pollInterval, _load);
  }

  Future<void> _edit(Site site) async {
    final update = await Navigator.of(context).push<SiteUpdate>(
      MaterialPageRoute<SiteUpdate>(
        builder: (_) => SiteFormScreen.edit(
          api: _api,
          site: site,
          onUnauthorized: () => widget.authState.invalidate(_api.token),
        ),
      ),
    );
    if (update == null || !mounted) return;
    if (update.moveQueued) {
      showSnack(context, '새 이름으로 옮기는 중입니다. 끝날 때까지 사이트가 잠깁니다.');
    } else {
      showSnack(context, '저장했습니다.');
    }
    await _load();
  }

  Future<void> _delete(Site site) async {
    final ok = await confirmDestructive(
      context,
      title: '${site.name} 사이트를 삭제할까요?',
      message:
          '모든 배포와 공개 주소가 함께 사라지고 되돌릴 수 없습니다. '
          '쓰던 이름은 이 팀만 다시 쓸 수 있습니다.',
      confirmLabel: '사이트 삭제',
    );
    if (!ok || !mounted) return;
    setState(() => _acting = true);
    try {
      await _api.deleteSite(site.id);
      if (!mounted) return;
      showSnack(context, '사이트를 삭제했습니다.');
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
    final detail = _gone ? null : _detail;
    final site = detail?.site;
    final canWrite = widget.team.canWrite;
    return Scaffold(
      appBar: AppBar(
        title: Text(site?.name ?? '사이트'),
        actions: [
          if (site != null && canWrite) ...[
            IconButton(
              tooltip: '사이트 편집',
              icon: const Icon(Icons.edit_outlined),
              onPressed: _acting ? null : () => _edit(site),
            ),
            PopupMenuButton<String>(
              tooltip: '더보기',
              onSelected: (v) {
                if (v == 'delete') _delete(site);
              },
              itemBuilder: (_) => [
                PopupMenuItem(
                  value: 'delete',
                  enabled: !site.busy && !_acting,
                  child: const Text('사이트 삭제'),
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
                  '이 사이트는 삭제되었거나 더 이상 볼 수 없습니다.',
                  textAlign: TextAlign.center,
                ),
              ),
            )
          : detail == null
          ? Center(
              child: _error == null
                  ? const CircularProgressIndicator()
                  : Padding(
                      padding: const EdgeInsets.all(24),
                      child: Text(
                        '사이트를 불러오지 못했습니다.\n$_error',
                        textAlign: TextAlign.center,
                      ),
                    ),
            )
          : RefreshIndicator(onRefresh: _load, child: _body(detail)),
    );
  }

  Widget _body(SiteDetail detail) {
    final site = detail.site;
    final textTheme = Theme.of(context).textTheme;
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(14, 8, 14, 24),
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                site.name,
                style: textTheme.titleLarge?.copyWith(
                  fontWeight: FontWeight.w800,
                ),
              ),
            ),
            StatusChip(
              label: siteStateLabel(site.state),
              tone: siteStateTone(site.state),
            ),
          ],
        ),
        if (site.description != null) ...[
          const SizedBox(height: 4),
          Text(site.description!),
        ],
        const SizedBox(height: 4),
        Text(
          '만든 사람 ${site.createdBy ?? '—'} · ${formatLocalTime(site.createdAt)}',
          style: textTheme.bodySmall?.copyWith(color: CatalogPalette.slate),
        ),
        const SizedBox(height: 10),
        if (site.movingTo != null)
          NoticeCard(
            icon: Icons.drive_file_move_outline,
            tone: ChipTone.accent,
            text:
                '${site.movingTo}(으)로 옮기는 중입니다. 끝나면 옛 주소는 더 이상 '
                '동작하지 않습니다.',
          )
        else if (site.busy)
          const NoticeCard(
            icon: Icons.hourglass_top_rounded,
            tone: ChipTone.accent,
            text: '작업이 진행 중입니다. 끝날 때까지 새 배포나 삭제는 할 수 없습니다.',
          ),
        if (detail.warning != null)
          NoticeCard(icon: Icons.warning_amber_rounded, text: detail.warning!),
        if (_error != null)
          NoticeCard(
            icon: Icons.cloud_off_rounded,
            tone: ChipTone.danger,
            text: '새로 불러오지 못했습니다. $_error',
          ),
        SectionCard(
          title: '주소',
          children: [
            CopyRow(label: '주소', value: site.displayUrl),
            if (site.otherUrl != null)
              CopyRow(
                label: site.otherUrl == site.hostUrl ? '전용 주소' : '경로 주소',
                value: site.otherUrl!,
              ),
            CopyRow(label: '기본 경로', value: site.basePath),
            CopyRow(label: '사이트 ID', value: site.id),
          ],
        ),
        SectionCard(
          title: '이름',
          children: [
            Text(site.domain ?? '없음 (무작위 주소 ${site.slug})'),
            const HintText('이름을 정하면 사이트 주소가 그 이름으로 바뀝니다. 편집에서 바꿀 수 있습니다.'),
          ],
        ),
        SectionCard(
          title: '현재 배포',
          children: [
            if (detail.currentDeploy == null)
              const Text('아직 배포가 없습니다.')
            else
              _DeployLine(deploy: detail.currentDeploy!),
            const HintText(
              '파일 업로드는 웹 콘솔이나 터미널의 `yyt site deploy <사이트> dist/`로 합니다.',
            ),
          ],
        ),
        SectionCard(
          title: '최근 배포',
          children: [
            if (detail.deploys.isEmpty)
              const Text('배포 기록이 없습니다.')
            else
              for (final d in detail.deploys) _DeployLine(deploy: d),
          ],
        ),
      ],
    );
  }
}

class _DeployLine extends StatelessWidget {
  const _DeployLine({required this.deploy});

  final SiteDeploy deploy;

  @override
  Widget build(BuildContext context) {
    final d = deploy;
    final what = d.isMove
        ? '이름 이동 → ${d.moveTo}'
        : '업로드 · 파일 ${d.files}개 · ${formatBytes(d.bytes)}';
    final tone = switch (d.status) {
      'live' => ChipTone.ok,
      'failed' => ChipTone.danger,
      'queued' || 'extracting' => ChipTone.warn,
      _ => ChipTone.neutral,
    };
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(what, maxLines: 1, overflow: TextOverflow.ellipsis),
                Text(
                  '${d.createdBy ?? '—'} · ${formatLocalTime(d.createdAt)}'
                  '${d.error == null ? '' : ' · ${d.error}'}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(
                    context,
                  ).textTheme.bodySmall?.copyWith(color: CatalogPalette.slate),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          StatusChip(label: siteDeployStatusLabel(d.status), tone: tone),
        ],
      ),
    );
  }
}
