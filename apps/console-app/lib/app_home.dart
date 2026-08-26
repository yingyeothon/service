import 'package:yyt_console/projects/models.dart';

/// Where a catalog app lives: its team (with the caller's seat) and project,
/// from the breadcrumb fields of the app view plus `/teams`. Lets the app
/// detail screen jump straight to the project's issues.
class AppHome {
  const AppHome({required this.team, required this.project});

  final Team team;
  final Project project;

  /// `null` when the view lacks the breadcrumb (older server).
  static AppHome? fromAppJson(Map<String, dynamic> j) {
    final teamId = j['teamId'];
    final projectId = j['projectId'];
    if (teamId is! String || projectId is! String) return null;
    return AppHome(
      team: Team(
        id: teamId,
        name: (j['teamName'] as String?) ?? teamId,
        role: (j['teamRole'] as String?) ?? 'member',
      ),
      project: Project(
        id: projectId,
        teamId: teamId,
        name: (j['projectName'] as String?) ?? projectId,
        description: '',
      ),
    );
  }
}
