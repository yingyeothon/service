import 'package:yyt_console/app_theme.dart';
import 'package:yyt_console/auth/auth_state.dart';
import 'package:yyt_console/fetch_remote_apps.dart' show UnauthorizedException;
import 'package:yyt_console/projects/discussions_screen.dart';
import 'package:yyt_console/projects/issue_detail_screen.dart';
import 'package:yyt_console/projects/issues_screen.dart';
import 'package:yyt_console/projects/models.dart';
import 'package:yyt_console/profile_menu.dart';
import 'package:yyt_console/projects/projects_api.dart';
import 'package:yyt_console/projects/team_expansion_store.dart';
import 'package:yyt_console/projects/team_issues_screen.dart';
import 'package:flutter/material.dart';

/// How many discussions each team shows before "전체 보기".
const recentDiscussionCount = 3;

/// How many of a team's issues (across its projects) the accordion shows.
const recentIssueCount = 5;

/// Teams the member is seated in, one accordion per team: the team's
/// discussions, its five most recently touched issues across every project,
/// then the project list. The first team starts open, the rest closed;
/// what the user toggles is kept on the device.
class ProjectsScreen extends StatefulWidget {
  const ProjectsScreen({
    super.key,
    required this.authState,
    this.api,
    this.expansionStore = const SecureTeamExpansionStore(),
  });

  final AuthState authState;

  /// Test seam; the screen builds and owns its own client otherwise.
  final ProjectsApi? api;

  final TeamExpansionStore expansionStore;

  @override
  State<ProjectsScreen> createState() => _ProjectsScreenState();
}

class _ProjectsScreenState extends State<ProjectsScreen> {
  List<Team>? _teams;
  Map<String, List<Project>> _projects = const {};
  Map<String, List<Discussion>> _discussions = const {};

  /// Per team: `null` while loading, an empty list when nothing came back.
  final Map<String, List<Issue>?> _recent = {};
  final Map<String, String> _recentErrors = {};

  /// Persisted accordion state; teams missing here use the default.
  Map<String, bool>? _expanded;
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

  /// Sorted teams: the first is open unless the device remembers otherwise.
  bool _isExpanded(Team team, int index) => _expanded?[team.id] ?? (index == 0);

  Future<void> _setExpanded(Team team, bool open) async {
    final next = {...?_expanded, team.id: open};
    setState(() => _expanded = next);
    if (open && team.canRead) _loadRecent(team);
    await widget.expansionStore.write(next);
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      _expanded ??= await widget.expansionStore.read();
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
      // Open accordions refetch their issues; closed ones load when opened.
      for (var i = 0; i < teams.length; i += 1) {
        if (teams[i].canRead && _isExpanded(teams[i], i)) {
          _loadRecent(teams[i]);
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

  Future<void> _loadRecent(Team team, {bool force = false}) async {
    if (!force && _recent.containsKey(team.id)) return;
    setState(() {
      _recent[team.id] = null;
      _recentErrors.remove(team.id);
    });
    try {
      final issues = await _api.listTeamIssuesCompat(
        team.id,
        _projects[team.id] ?? const [],
        limit: recentIssueCount,
      );
      if (!mounted) return;
      setState(() => _recent[team.id] = issues);
    } on UnauthorizedException {
      if (mounted) await widget.authState.invalidate(_api.token);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _recent[team.id] = const [];
        _recentErrors[team.id] = e.toString();
      });
    }
  }

  Project? _projectOf(Team team, Issue issue) =>
      (_projects[team.id] ?? const <Project>[])
          .where((p) => p.id == issue.projectId)
          .firstOrNull;

  Future<void> _openIssue(Team team, Issue issue) async {
    // The project list may have failed or changed since; the detail route
    // only needs the id, so a stub keeps the row tappable.
    final project =
        _projectOf(team, issue) ?? projectStub(team, issue.projectId);
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
    if (mounted) await _loadRecent(team, force: true);
  }

  Future<void> _openTeamIssues(Team team) async {
    await Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder:
            (_) => TeamIssuesScreen(
              authState: widget.authState,
              team: team,
              projects: _projects[team.id] ?? const [],
              api: _api,
            ),
      ),
    );
    if (mounted) await _loadRecent(team, force: true);
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
    if (mounted) await _loadRecent(team, force: true);
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
    final teams = _teams ?? const <Team>[];
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
          else if (teams.isEmpty)
            const _Message(
              icon: Icons.groups_outlined,
              text: '속한 팀이 없습니다. 콘솔에서 팀에 참여한 뒤 다시 시도해주세요.',
            )
          else
            for (var i = 0; i < teams.length; i += 1)
              _teamAccordion(teams[i], expanded: _isExpanded(teams[i], i)),
        ],
      ),
    );
  }

  Widget _teamAccordion(Team team, {required bool expanded}) {
    final projects = _projects[team.id] ?? const <Project>[];
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Theme(
        data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
        child: ExpansionTile(
          // The store is read before the first tile exists, so
          // `initiallyExpanded` already carries the saved state.
          key: PageStorageKey<String>('team-${team.id}'),
          initiallyExpanded: expanded,
          onExpansionChanged: (open) => _setExpanded(team, open),
          tilePadding: const EdgeInsets.fromLTRB(16, 4, 12, 4),
          childrenPadding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
          title: Text(
            team.name,
            style: Theme.of(
              context,
            ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
          ),
          subtitle: Text(
            teamRoleLabel(team.role),
            style: Theme.of(context).textTheme.bodySmall,
          ),
          children: [
            if (!team.canRead)
              const Padding(
                padding: EdgeInsets.symmetric(horizontal: 4, vertical: 6),
                child: Text('팀 소유자의 승인을 기다리는 중입니다.'),
              )
            else ...[
              _discussionCard(team),
              _recentIssuesCard(team),
              _sectionLabel('프로젝트'),
              if (projects.isEmpty)
                const Padding(
                  padding: EdgeInsets.symmetric(horizontal: 4, vertical: 6),
                  child: Text('프로젝트가 없습니다.'),
                )
              else
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
        ),
      ),
    );
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

  Widget _recentIssuesCard(Team team) {
    final issues = _recent[team.id];
    final error = _recentErrors[team.id];
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
                    Icons.error_outline_rounded,
                    size: 18,
                    color: CatalogPalette.mint,
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      '최근 이슈',
                      style: Theme.of(context).textTheme.titleSmall,
                    ),
                  ),
                ],
              ),
            ),
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
                padding: const EdgeInsets.fromLTRB(12, 4, 12, 8),
                child: Text('이슈를 불러오지 못했습니다.\n$error'),
              )
            else if (issues.isEmpty)
              const Padding(
                padding: EdgeInsets.fromLTRB(12, 4, 12, 8),
                child: Text('이슈가 없습니다.'),
              )
            else
              for (final issue in issues)
                TeamIssueTile(
                  issue: issue,
                  projectName: _projectOf(team, issue)?.name,
                  dense: true,
                  onTap: () => _openIssue(team, issue),
                ),
            if (issues != null && error == null && issues.isNotEmpty)
              Align(
                alignment: Alignment.centerRight,
                child: TextButton(
                  onPressed: () => _openTeamIssues(team),
                  child: const Text('더보기'),
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
