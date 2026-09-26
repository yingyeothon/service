import 'package:yyt_console/auth/auth_state.dart';
import 'package:yyt_console/projects/channels_tab.dart';
import 'package:yyt_console/projects/issues_screen.dart';
import 'package:yyt_console/projects/models.dart';
import 'package:yyt_console/projects/projects_api.dart';
import 'package:yyt_console/projects/resource_widgets.dart';
import 'package:yyt_console/projects/sites_tab.dart';
import 'package:flutter/material.dart';

enum ProjectTab { issues, sites, channels }

/// One project: issues, sites and channels as tabs. Owns the one client every
/// tab and every screen pushed from them uses, so the whole visit talks to the
/// server and token captured when it opened.
class ProjectScreen extends StatefulWidget {
  const ProjectScreen({
    super.key,
    required this.authState,
    required this.team,
    required this.project,
    this.initialTab = ProjectTab.issues,
    this.api,
  });

  final AuthState authState;
  final Team team;
  final Project project;
  final ProjectTab initialTab;

  /// Test seam; the screen builds and owns its own client otherwise.
  final ProjectsApi? api;

  @override
  State<ProjectScreen> createState() => _ProjectScreenState();
}

class _ProjectScreenState extends State<ProjectScreen> {
  late final ProjectsApi _api = widget.api ?? _fromActiveProfile();

  ProjectsApi _fromActiveProfile() {
    final p = widget.authState.activeProfile;
    return ProjectsApi(token: p?.apiKey ?? '', baseUrl: p?.server);
  }

  @override
  void dispose() {
    if (widget.api == null) _api.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final team = widget.team;
    return DefaultTabController(
      length: ProjectTab.values.length,
      initialIndex: widget.initialTab.index,
      child: Scaffold(
        appBar: AppBar(
          title: Text('${team.name} / ${widget.project.name}'),
          bottom: const TabBar(
            tabs: [Tab(text: '이슈'), Tab(text: '사이트'), Tab(text: '채널')],
          ),
        ),
        body: Column(
          children: [
            if (!team.canWrite)
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 8, 14, 0),
                child: NoticeCard(
                  icon: Icons.visibility_outlined,
                  tone: ChipTone.neutral,
                  text:
                      team.role == 'admin'
                          ? '읽기 전용입니다. 플랫폼 관리자는 채널을 연장하거나 삭제할 수 있지만, '
                              '만들거나 고치거나 시크릿을 볼 수는 없습니다.'
                          : '읽기 전용입니다. 팀 좌석(소유자·멤버)이 있어야 만들거나 고칠 수 있습니다.',
                ),
              ),
            Expanded(
              child: TabBarView(
                children: [
                  IssuesTab(
                    authState: widget.authState,
                    team: team,
                    project: widget.project,
                    api: _api,
                  ),
                  SitesTab(
                    authState: widget.authState,
                    team: team,
                    project: widget.project,
                    api: _api,
                  ),
                  ChannelsTab(
                    authState: widget.authState,
                    team: team,
                    project: widget.project,
                    api: _api,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
