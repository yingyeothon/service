import 'package:yyt_console/app_theme.dart';
import 'package:yyt_console/auth/auth_state.dart';
import 'package:yyt_console/fetch_remote_apps.dart' show UnauthorizedException;
import 'package:yyt_console/projects/issue_detail_screen.dart';
import 'package:yyt_console/projects/models.dart';
import 'package:yyt_console/projects/projects_api.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

String formatIssueTime(DateTime t) =>
    DateFormat('yyyy-MM-dd HH:mm').format(t.toLocal());

/// Issues of one project with an open/closed filter and a create button.
class IssuesScreen extends StatefulWidget {
  const IssuesScreen({
    super.key,
    required this.authState,
    required this.team,
    required this.project,
  });

  final AuthState authState;
  final Team team;
  final Project project;

  @override
  State<IssuesScreen> createState() => _IssuesScreenState();
}

class _IssuesScreenState extends State<IssuesScreen> {
  List<Issue>? _issues;
  String? _error;
  String _status = 'open';

  late final ProjectsApi _api = ProjectsApi(
    token: widget.authState.token ?? '',
  );

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _api.close();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final issues = await _api.listIssues(
        widget.project.id,
        status: _status == 'all' ? null : _status,
      );
      if (!mounted) return;
      setState(() {
        _issues = issues;
        _error = null;
      });
    } on UnauthorizedException {
      if (mounted) await widget.authState.invalidate(_api.token);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString());
    }
  }

  Future<void> _create() async {
    final created = await Navigator.of(context).push<Issue>(
      MaterialPageRoute<Issue>(
        builder:
            (_) => IssueCreateScreen(
              api: _api,
              project: widget.project,
              onUnauthorized: () => widget.authState.invalidate(_api.token),
            ),
      ),
    );
    if (created != null && mounted) {
      await _load();
      if (!mounted) return;
      await _open(created);
    }
  }

  Future<void> _open(Issue issue) async {
    await Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder:
            (_) => IssueDetailScreen(
              authState: widget.authState,
              team: widget.team,
              project: widget.project,
              number: issue.number,
            ),
      ),
    );
    if (mounted) await _load();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('${widget.team.name} / ${widget.project.name}'),
      ),
      floatingActionButton:
          widget.team.canWrite
              ? FloatingActionButton.extended(
                onPressed: _create,
                icon: const Icon(Icons.add_rounded),
                label: const Text('이슈 등록'),
              )
              : null,
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 8, 14, 4),
            child: SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'open', label: Text('열림')),
                ButtonSegment(value: 'closed', label: Text('닫힘')),
                ButtonSegment(value: 'all', label: Text('전체')),
              ],
              selected: {_status},
              onSelectionChanged: (s) {
                setState(() {
                  _status = s.first;
                  _issues = null;
                });
                _load();
              },
            ),
          ),
          Expanded(child: _body()),
        ],
      ),
    );
  }

  Widget _body() {
    if (_issues == null && _error == null) {
      return const Center(child: CircularProgressIndicator());
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(14, 8, 14, 96),
        children: [
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 60),
              child: Text(
                '이슈를 불러오지 못했습니다.\n$_error',
                textAlign: TextAlign.center,
              ),
            )
          else if (_issues!.isEmpty)
            const Padding(
              padding: EdgeInsets.only(top: 60),
              child: Text('이슈가 없습니다.', textAlign: TextAlign.center),
            )
          else
            for (final issue in _issues!)
              Card(
                margin: const EdgeInsets.only(bottom: 8),
                child: ListTile(
                  leading: IssueStatusIcon(open: issue.isOpen),
                  title: Text('#${issue.number} ${issue.title}'),
                  subtitle: Text(
                    '${issue.createdBy} · ${formatIssueTime(issue.updatedAt)}',
                  ),
                  onTap: () => _open(issue),
                ),
              ),
        ],
      ),
    );
  }
}

class IssueStatusIcon extends StatelessWidget {
  const IssueStatusIcon({super.key, required this.open});

  final bool open;

  @override
  Widget build(BuildContext context) {
    return Icon(
      open ? Icons.error_outline_rounded : Icons.check_circle_outline_rounded,
      color: open ? CatalogPalette.mint : CatalogPalette.slate,
    );
  }
}

/// Title + Markdown body form; pops with the created issue.
class IssueCreateScreen extends StatefulWidget {
  const IssueCreateScreen({
    super.key,
    required this.api,
    required this.project,
    required this.onUnauthorized,
  });

  final ProjectsApi api;
  final Project project;
  final Future<void> Function() onUnauthorized;

  /// Server cap for `bodyMd` (services/console/src/team.ts).
  static const bodyMaxLength = 20000;

  @override
  State<IssueCreateScreen> createState() => _IssueCreateScreenState();
}

class _IssueCreateScreenState extends State<IssueCreateScreen> {
  final _title = TextEditingController();
  final _body = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _title.dispose();
    _body.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final title = _title.text.trim();
    if (title.isEmpty) {
      setState(() => _error = '제목을 입력해주세요.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final issue = await widget.api.createIssue(
        widget.project.id,
        title: title,
        bodyMd: _body.text.trim(),
      );
      if (mounted) Navigator.of(context).pop(issue);
    } on UnauthorizedException {
      await widget.onUnauthorized();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e.toString();
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('${widget.project.name} · 새 이슈')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          TextField(
            controller: _title,
            autofocus: true,
            maxLength: 200,
            textInputAction: TextInputAction.next,
            decoration: const InputDecoration(labelText: '제목'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _body,
            minLines: 6,
            maxLines: 20,
            maxLength: IssueCreateScreen.bodyMaxLength,
            decoration: const InputDecoration(
              labelText: '내용 (Markdown)',
              alignLabelWithHint: true,
            ),
          ),
          if (_error != null) ...[
            const SizedBox(height: 12),
            Text(_error!, style: const TextStyle(color: Colors.red)),
          ],
          const SizedBox(height: 20),
          FilledButton.icon(
            onPressed: _busy ? null : _submit,
            icon:
                _busy
                    ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                    : const Icon(Icons.send_rounded),
            label: const Text('등록'),
          ),
        ],
      ),
    );
  }
}
