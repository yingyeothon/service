import 'package:yyt_console/app_theme.dart';
import 'package:yyt_console/auth/auth_state.dart';
import 'package:yyt_console/fetch_remote_apps.dart' show UnauthorizedException;
import 'package:yyt_console/projects/discussions_screen.dart';
import 'package:yyt_console/projects/issue_detail_screen.dart';
import 'package:yyt_console/projects/issues_screen.dart';
import 'package:yyt_console/projects/models.dart';
import 'package:yyt_console/profile_menu.dart';
import 'package:yyt_console/projects/projects_api.dart';
import 'package:flutter/material.dart';

/// How many discussions the tab shows before "전체 보기".
const recentDiscussionCount = 3;

/// How many issues each project accordion shows.
const recentIssueCount = 5;

/// Newest activity first, capped to [recentIssueCount].
List<Issue> recentIssues(List<Issue> issues) =>
    (issues.toList()..sort((a, b) => b.updatedAt.compareTo(a.updatedAt)))
        .take(recentIssueCount)
        .toList();

/// Teams the member is seated in. Per team, two sections: the team's
/// discussions plus one accordion per project with its latest issues (the
/// first project starts open), then the plain project list.
class ProjectsScreen extends StatefulWidget {
  const ProjectsScreen({super.key, required this.authState, this.api});

  final AuthState authState;

  /// Test seam; the screen builds and owns its own client otherwise.
  final ProjectsApi? api;

  @override
  State<ProjectsScreen> createState() => _ProjectsScreenState();
}

class _ProjectsScreenState extends State<ProjectsScreen> {
  List<Team>? _teams;
  Map<String, List<Project>> _projects = const {};
  Map<String, List<Discussion>> _discussions = const {};

  /// Per project: `null` while loading, an empty list when nothing came back.
  final Map<String, List<Issue>?> _recent = {};

  /// Projects whose accordion is open; a refresh refetches exactly these.
  final Set<String> _expanded = {};

  /// Teams whose first project was auto-expanded once; a later refresh
  /// respects what the user collapsed.
  final Set<String> _seenTeams = {};
  final Map<String, String> _recentErrors = {};
  String? _error;
  bool _loading = false;

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
    setState(() => _loading = true);
    try {
      final teams =
          (await _api.listTeams()).toList()
            ..sort((a, b) => a.name.compareTo(b.name));
      final projects = <String, List<Project>>{};
      final discussions = <String, List<Discussion>>{};
      for (final team in teams) {
        if (!team.canRead) {
          projects[team.id] = const [];
          discussions[team.id] = const [];
          continue;
        }
        final results = await Future.wait<Object?>([
          _api.listProjects(team.id).catchError((Object e) {
            if (e is ApiException) return <Project>[];
            throw e;
          }),
          _api.listDiscussions(team.id).catchError((Object e) {
            if (e is ApiException) return <Discussion>[];
            throw e;
          }),
        ]);
        projects[team.id] =
            (results[0] as List<Project>)
              ..sort((a, b) => a.name.compareTo(b.name));
        discussions[team.id] = sortDiscussionsNewestFirst(
          results[1] as List<Discussion>,
        );
      }
      if (!mounted) return;
      setState(() {
        _teams = teams;
        _projects = projects;
        _discussions = discussions;
        _recent.clear();
        _recentErrors.clear();
        _error = null;
      });
      // The first project of every team starts expanded (the ExpansionTile
      // keeps its open state across rebuilds, so `_expanded` remembers the
      // rest); every open accordion refetches, the others load when opened.
      final known = <String>{};
      for (final team in teams) {
        final list = projects[team.id] ?? const <Project>[];
        for (final project in list) {
          known.add(project.id);
        }
        final first = list.firstOrNull;
        if (first != null && !_seenTeams.contains(team.id)) {
          _expanded.add(first.id);
        }
        _seenTeams.add(team.id);
      }
      _expanded.retainAll(known);
      for (final team in teams) {
        for (final project in projects[team.id] ?? const <Project>[]) {
          if (_expanded.contains(project.id)) _loadRecent(project);
        }
      }
    } on UnauthorizedException {
      if (mounted) await widget.authState.invalidate(_api.token);
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _loadRecent(Project project, {bool force = false}) async {
    if (!force && _recent.containsKey(project.id)) return;
    setState(() {
      _recent[project.id] = null;
      _recentErrors.remove(project.id);
    });
    try {
      final issues = recentIssues(await _api.listIssues(project.id));
      if (!mounted) return;
      setState(() => _recent[project.id] = issues);
    } on UnauthorizedException {
      if (mounted) await widget.authState.invalidate(_api.token);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _recent[project.id] = const [];
        _recentErrors[project.id] = e.toString();
      });
    }
  }

  Future<void> _openIssue(Team team, Project project, Issue issue) async {
    await Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder:
            (_) => IssueDetailScreen(
              authState: widget.authState,
              team: team,
              project: project,
              number: issue.number,
            ),
      ),
    );
    if (mounted) await _loadRecent(project, force: true);
  }

  Future<void> _openIssues(Team team, Project project) async {
    await Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder:
            (_) => IssuesScreen(
              authState: widget.authState,
              team: team,
              project: project,
            ),
      ),
    );
    if (mounted) await _loadRecent(project, force: true);
  }

  Future<void> _openDiscussions(Team team) async {
    await Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder:
            (_) => DiscussionsScreen(authState: widget.authState, team: team),
      ),
    );
    if (mounted) await _load();
  }

  Future<void> _openDiscussion(Team team, Discussion d) async {
    await openDiscussion(
      context,
      authState: widget.authState,
      team: team,
      id: d.id,
    );
    if (mounted) await _load();
  }

  Future<void> _createDiscussion(Team team) async {
    final created = await createDiscussionFlow(
      context,
      api: _api,
      authState: widget.authState,
      team: team,
    );
    if (created == null || !mounted) return;
    await _openDiscussion(team, created);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        toolbarHeight: 64,
        title: Row(
          children: [
            ClipRRect(
              borderRadius: BorderRadius.circular(10),
              child: Image.asset('assets/icon.png', width: 34, height: 34),
            ),
            const SizedBox(width: 10),
            Text('잉여톤 · 프로젝트', style: Theme.of(context).textTheme.titleMedium),
          ],
        ),
        actions: [
          IconButton(
            tooltip: '새로고침',
            icon:
                _loading
                    ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                    : const Icon(Icons.refresh_rounded),
            onPressed: _loading ? null : _load,
          ),
          ProfileMenuButton(authState: widget.authState),
          const SizedBox(width: 4),
        ],
      ),
      body: _body(),
    );
  }

  Widget _body() {
    if (_teams == null && _error == null) {
      return const Center(child: CircularProgressIndicator());
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(14, 8, 14, 24),
        children: [
          if (_error != null)
            _Message(
              icon: Icons.cloud_off_rounded,
              text: '프로젝트를 불러오지 못했습니다.\n$_error',
            )
          else if (_teams!.isEmpty)
            const _Message(
              icon: Icons.groups_outlined,
              text: '속한 팀이 없습니다. 콘솔에서 팀에 참여한 뒤 다시 시도해주세요.',
            )
          else
            for (final team in _teams!) ..._teamSection(team),
        ],
      ),
    );
  }

  List<Widget> _teamSection(Team team) {
    final projects = _projects[team.id] ?? const <Project>[];
    return [
      Padding(
        padding: const EdgeInsets.fromLTRB(4, 12, 4, 6),
        child: Row(
          children: [
            Expanded(
              child: Text(
                team.name,
                style: Theme.of(
                  context,
                ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
              ),
            ),
            Chip(
              label: Text(teamRoleLabel(team.role)),
              visualDensity: VisualDensity.compact,
            ),
          ],
        ),
      ),
      if (!team.canRead)
        const Padding(
          padding: EdgeInsets.symmetric(horizontal: 4, vertical: 6),
          child: Text('팀 소유자의 승인을 기다리는 중입니다.'),
        )
      else ...[
        // Section 1: discussions + the latest issues per project.
        _discussionCard(team),
        if (projects.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(horizontal: 4, vertical: 6),
            child: Text('프로젝트가 없습니다.'),
          )
        else ...[
          _sectionLabel('최근 이슈'),
          for (var i = 0; i < projects.length; i += 1)
            _projectAccordion(
              team,
              projects[i],
              initiallyExpanded: _expanded.contains(projects[i].id),
            ),
          // Section 2: the project list.
          _sectionLabel('프로젝트'),
          for (final project in projects)
            Card(
              margin: const EdgeInsets.only(bottom: 8),
              child: ListTile(
                title: Text(project.name),
                subtitle:
                    project.description.isEmpty
                        ? null
                        : Text(
                          project.description,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                        ),
                trailing: const Icon(Icons.chevron_right_rounded),
                onTap: () => _openIssues(team, project),
              ),
            ),
        ],
      ],
    ];
  }

  Widget _sectionLabel(String text) => Padding(
    padding: const EdgeInsets.fromLTRB(4, 10, 4, 6),
    child: Text(
      text,
      style: Theme.of(
        context,
      ).textTheme.titleSmall?.copyWith(color: CatalogPalette.slate),
    ),
  );

  Widget _discussionCard(Team team) {
    final items = _discussions[team.id] ?? const <Discussion>[];
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(4, 8, 4, 4),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: Row(
                children: [
                  const Icon(
                    Icons.forum_outlined,
                    size: 18,
                    color: CatalogPalette.ocean,
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      '팀 토론 ${items.length}',
                      style: Theme.of(context).textTheme.titleSmall,
                    ),
                  ),
                  if (team.canWrite)
                    TextButton.icon(
                      onPressed: () => _createDiscussion(team),
                      icon: const Icon(Icons.add_rounded, size: 18),
                      label: const Text('토론 시작'),
                    ),
                ],
              ),
            ),
            if (items.isEmpty)
              const Padding(
                padding: EdgeInsets.fromLTRB(12, 4, 12, 8),
                child: Text('아직 토론이 없습니다.'),
              )
            else
              for (final d in items.take(recentDiscussionCount))
                DiscussionTile(
                  discussion: d,
                  onTap: () => _openDiscussion(team, d),
                ),
            if (items.length > recentDiscussionCount)
              Align(
                alignment: Alignment.centerRight,
                child: TextButton(
                  onPressed: () => _openDiscussions(team),
                  child: Text('전체 보기 (${items.length})'),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _projectAccordion(
    Team team,
    Project project, {
    required bool initiallyExpanded,
  }) {
    final issues = _recent[project.id];
    final error = _recentErrors[project.id];
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: Theme(
        data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
        child: ExpansionTile(
          key: PageStorageKey<String>('recent-${project.id}'),
          initiallyExpanded: initiallyExpanded,
          onExpansionChanged: (open) {
            if (open) {
              _expanded.add(project.id);
              _loadRecent(project);
            } else {
              _expanded.remove(project.id);
            }
          },
          tilePadding: const EdgeInsets.fromLTRB(16, 4, 12, 4),
          childrenPadding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
          title: Text(project.name),
          subtitle:
              issues == null
                  ? null
                  : Text(
                    issues.isEmpty ? '이슈 없음' : '최근 이슈 ${issues.length}개',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
          children: [
            if (issues == null)
              const Padding(
                padding: EdgeInsets.all(12),
                child: Center(
                  child: SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                ),
              )
            else if (error != null)
              Padding(
                padding: const EdgeInsets.all(12),
                child: Text('이슈를 불러오지 못했습니다.\n$error'),
              )
            else if (issues.isEmpty)
              const Padding(
                padding: EdgeInsets.all(12),
                child: Text('이슈가 없습니다.'),
              )
            else
              for (final issue in issues)
                ListTile(
                  dense: true,
                  leading: IssueStatusIcon(open: issue.isOpen),
                  title: Text(
                    '#${issue.number} ${issue.title}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  subtitle: Text(
                    '${issue.createdBy} · ${formatIssueTime(issue.updatedAt)}',
                  ),
                  onTap: () => _openIssue(team, project, issue),
                ),
            Align(
              alignment: Alignment.centerRight,
              child: TextButton(
                onPressed: () => _openIssues(team, project),
                child: const Text('전체 이슈'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Message extends StatelessWidget {
  const _Message({required this.icon, required this.text});

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 80),
      child: Column(
        children: [
          Icon(icon, size: 40, color: CatalogPalette.slate),
          const SizedBox(height: 12),
          Text(text, textAlign: TextAlign.center),
        ],
      ),
    );
  }
}
