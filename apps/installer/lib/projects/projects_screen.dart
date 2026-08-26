import 'package:catalog/app_theme.dart';
import 'package:catalog/auth/auth_state.dart';
import 'package:catalog/fetch_remote_apps.dart' show UnauthorizedException;
import 'package:catalog/projects/issues_screen.dart';
import 'package:catalog/projects/models.dart';
import 'package:catalog/projects/projects_api.dart';
import 'package:flutter/material.dart';

/// Teams the member is seated in, each expanded into its projects. Tapping a
/// project opens its issues.
class ProjectsScreen extends StatefulWidget {
  const ProjectsScreen({super.key, required this.authState});

  final AuthState authState;

  @override
  State<ProjectsScreen> createState() => _ProjectsScreenState();
}

class _ProjectsScreenState extends State<ProjectsScreen> {
  List<Team>? _teams;
  Map<String, List<Project>> _projects = const {};
  String? _error;
  bool _loading = false;

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
    setState(() => _loading = true);
    try {
      final teams =
          (await _api.listTeams()).toList()
            ..sort((a, b) => a.name.compareTo(b.name));
      final projects = <String, List<Project>>{};
      for (final team in teams) {
        if (!team.canRead) {
          projects[team.id] = const [];
          continue;
        }
        try {
          projects[team.id] = (await _api.listProjects(team.id))
            ..sort((a, b) => a.name.compareTo(b.name));
        } on ApiException {
          projects[team.id] = const [];
        }
      }
      if (!mounted) return;
      setState(() {
        _teams = teams;
        _projects = projects;
        _error = null;
      });
    } on UnauthorizedException {
      await widget.authState.logout();
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
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
            for (final team in _teams!) ...[
              Padding(
                padding: const EdgeInsets.fromLTRB(4, 12, 4, 6),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        team.name,
                        style: Theme.of(context).textTheme.titleMedium
                            ?.copyWith(fontWeight: FontWeight.w800),
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
              else if ((_projects[team.id] ?? const []).isEmpty)
                const Padding(
                  padding: EdgeInsets.symmetric(horizontal: 4, vertical: 6),
                  child: Text('프로젝트가 없습니다.'),
                )
              else
                for (final project in _projects[team.id]!)
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
                      onTap:
                          () => Navigator.of(context).push(
                            MaterialPageRoute<void>(
                              builder:
                                  (_) => IssuesScreen(
                                    authState: widget.authState,
                                    team: team,
                                    project: project,
                                  ),
                            ),
                          ),
                    ),
                  ),
            ],
        ],
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
