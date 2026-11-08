import 'package:yyt_console/app_theme.dart';
import 'package:yyt_console/auth/auth_state.dart';
import 'package:yyt_console/fetch_remote_apps.dart' show UnauthorizedException;
import 'package:yyt_console/projects/models.dart';
import 'package:yyt_console/projects/projects_api.dart';
import 'package:yyt_console/projects/resource_widgets.dart';
import 'package:yyt_console/projects/tracer_detail_screen.dart';
import 'package:yyt_console/projects/tracer_form_screen.dart';
import 'package:yyt_console/projects/tracer_models.dart';
import 'package:flutter/material.dart';

/// The tracer tab of [ProjectScreen]: one line per debug-data resource and a
/// create button for seated members. An unseated platform admin sees the
/// rows but cannot open one: the resource view carries the write key and the
/// server refuses it (docs/decisions.md *Debug collector* #8).
class TracersTab extends StatefulWidget {
  const TracersTab({
    super.key,
    required this.authState,
    required this.team,
    required this.project,
    required this.api,
  });

  final AuthState authState;
  final Team team;
  final Project project;
  final ProjectsApi api;

  @override
  State<TracersTab> createState() => _TracersTabState();
}

class _TracersTabState extends State<TracersTab>
    with AutomaticKeepAliveClientMixin {
  List<Tracer>? _tracers;
  String? _error;

  /// The console predates tracer resources (404 on the list route): a hint,
  /// never an error, and nothing to create.
  bool _unsupported = false;

  ProjectsApi get _api => widget.api;

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final tracers = await _api.listTracers(widget.project.id);
      if (!mounted) return;
      setState(() {
        _tracers = tracers;
        _error = null;
      });
    } on UnauthorizedException {
      if (mounted) await widget.authState.invalidate(_api.token);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _unsupported = e.status == 404;
        _error = e.status == 404 ? null : e.message;
        if (_unsupported) _tracers = const [];
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString());
    }
  }

  Future<void> _create() async {
    final created = await Navigator.of(context).push<Tracer>(
      MaterialPageRoute<Tracer>(
        builder: (_) => TracerFormScreen.create(
          api: _api,
          project: widget.project,
          onUnauthorized: () => widget.authState.invalidate(_api.token),
        ),
      ),
    );
    if (created == null || !mounted) return;
    await _load();
    if (!mounted) return;
    // The DSN is what a creator came for.
    await _open(created.id);
  }

  Future<void> _open(String id) async {
    await Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (_) => TracerDetailScreen(
          authState: widget.authState,
          team: widget.team,
          api: _api,
          tracerId: id,
        ),
      ),
    );
    if (mounted) await _load();
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    return Scaffold(
      floatingActionButton: widget.team.canWrite && !_unsupported
          ? FloatingActionButton.extended(
              heroTag: 'fab-tracers',
              onPressed: _create,
              icon: const Icon(Icons.add_rounded),
              label: const Text('트레이서 만들기'),
            )
          : null,
      body: _body(),
    );
  }

  Widget _body() {
    final tracers = _tracers;
    if (tracers == null && _error == null) {
      return const Center(child: CircularProgressIndicator());
    }
    final canOpen = widget.team.canWrite;
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(14, 8, 14, 96),
        children: [
          if (_unsupported)
            const Padding(
              padding: EdgeInsets.only(top: 60),
              child: Text(
                '이 콘솔 서버는 아직 트레이서를 지원하지 않습니다.',
                textAlign: TextAlign.center,
              ),
            )
          else if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 60),
              child: Text(
                '트레이서를 불러오지 못했습니다.\n$_error',
                textAlign: TextAlign.center,
              ),
            )
          else ...[
            const HintText(
              '디버그 빌드가 보낸 기록(이벤트, 로그, 스크린샷)을 모읍니다. 백업은 없고 최대 30일 '
              '보관됩니다. 읽기는 터미널의 `yyt tracer`나 tracer-debug 스킬로 합니다.',
            ),
            if (tracers!.isEmpty)
              const Padding(
                padding: EdgeInsets.only(top: 48),
                child: Text(
                  '트레이서 리소스가 없습니다.\n디버그 빌드의 기록을 받을 리소스를 만들 수 있습니다.',
                  textAlign: TextAlign.center,
                ),
              )
            else
              for (final t in tracers)
                Card(
                  margin: const EdgeInsets.only(bottom: 8),
                  child: ListTile(
                    leading: const Icon(
                      Icons.bug_report_outlined,
                      color: CatalogPalette.ocean,
                    ),
                    title: Text(
                      t.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    subtitle: Text(
                      t.id,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    onTap: canOpen ? () => _open(t.id) : null,
                  ),
                ),
          ],
        ],
      ),
    );
  }
}
