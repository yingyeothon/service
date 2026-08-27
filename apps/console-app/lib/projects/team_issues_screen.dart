import 'package:yyt_console/auth/auth_state.dart';
import 'package:yyt_console/fetch_remote_apps.dart' show UnauthorizedException;
import 'package:yyt_console/projects/issue_detail_screen.dart';
import 'package:yyt_console/projects/issues_screen.dart';
import 'package:yyt_console/projects/models.dart';
import 'package:yyt_console/projects/projects_api.dart';
import 'package:flutter/material.dart';

/// Every issue of a team across its projects, most recently touched first
/// (an edit, a status change, or a new comment), with an open/closed filter.
class TeamIssuesScreen extends StatefulWidget {
  const TeamIssuesScreen({
    super.key,
    required this.authState,
    required this.team,
    required this.projects,
    this.api,
  });

  final AuthState authState;
  final Team team;

  /// Resolves an issue's `projectId` to its name and the detail route.
  final List<Project> projects;

  /// Test seam; the screen builds and owns its own client otherwise.
  final ProjectsApi? api;

  @override
  State<TeamIssuesScreen> createState() => _TeamIssuesScreenState();
}

class _TeamIssuesScreenState extends State<TeamIssuesScreen> {
  List<Issue>? _issues;
  String? _error;
  String _status = 'all';

  /// Bumped per request so a slow reply for the previous filter is dropped.
  int _generation = 0;

  /// Server cap per page; the console app has no paging yet.
  static const pageLimit = 200;

  late final ProjectsApi _api =
      widget.api ?? ProjectsApi(token: widget.authState.token ?? '');

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    if (widget.api == null) _api.close();
    super.dispose();
  }

  Future<void> _load() async {
    final generation = ++_generation;
    try {
      final issues = await _api.listTeamIssuesCompat(
        widget.team.id,
        widget.projects,
        status: _status == 'all' ? null : _status,
        limit: pageLimit,
      );
      if (!mounted || generation != _generation) return;
      setState(() {
        _issues = issues;
        _error = null;
      });
    } on UnauthorizedException {
      if (mounted) await widget.authState.invalidate(_api.token);
    } catch (e) {
      if (!mounted || generation != _generation) return;
      setState(() => _error = e.toString());
    }
  }

  Project? _projectOf(Issue issue) =>
      widget.projects.where((p) => p.id == issue.projectId).firstOrNull;

  Future<void> _open(Issue issue) async {
    final project =
        _projectOf(issue) ?? projectStub(widget.team, issue.projectId);
    await Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder:
            (_) => IssueDetailScreen(
              authState: widget.authState,
              team: widget.team,
              project: project,
              number: issue.number,
            ),
      ),
    );
    if (mounted) await _load();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('${widget.team.name} · 이슈')),
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
        padding: const EdgeInsets.fromLTRB(14, 8, 14, 24),
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
                child: TeamIssueTile(
                  issue: issue,
                  projectName: _projectOf(issue)?.name,
                  onTap: () => _open(issue),
                ),
              ),
        ],
      ),
    );
  }
}

/// A placeholder for an issue whose project is not in the loaded list
/// (list failed, or the project changed since); enough for the detail route.
Project projectStub(Team team, String projectId) =>
    Project(id: projectId, teamId: team.id, name: projectId, description: '');

/// One issue row prefixed with its project name; shared with the projects
/// tab's recent list.
class TeamIssueTile extends StatelessWidget {
  const TeamIssueTile({
    super.key,
    required this.issue,
    required this.projectName,
    required this.onTap,
    this.dense = false,
  });

  final Issue issue;
  final String? projectName;
  final VoidCallback onTap;
  final bool dense;

  @override
  Widget build(BuildContext context) {
    final prefix = projectName == null ? '' : '$projectName · ';
    return ListTile(
      dense: dense,
      leading: IssueStatusIcon(open: issue.isOpen),
      title: Text(
        '#${issue.number} ${issue.title}',
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      subtitle: Text(
        '$prefix${issue.createdBy} · ${formatIssueTime(issue.updatedAt)}',
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      onTap: onTap,
    );
  }
}
