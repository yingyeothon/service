import 'package:yyt_console/app_home.dart';
import 'package:yyt_console/auth/auth_state.dart';
import 'package:yyt_console/projects/issues_screen.dart';
import 'package:flutter/material.dart';

/// Opens the issues of the project an app belongs to.
class ProjectIssuesButton extends StatelessWidget {
  const ProjectIssuesButton({
    super.key,
    required this.authState,
    required this.home,
  });

  final AuthState authState;
  final AppHome home;

  @override
  Widget build(BuildContext context) {
    return FilledButton.tonalIcon(
      icon: const Icon(Icons.bug_report_outlined, size: 18),
      label: Text('${home.team.name} › ${home.project.name} 이슈'),
      onPressed:
          () => Navigator.of(context).push(
            MaterialPageRoute<void>(
              builder:
                  (_) => IssuesScreen(
                    authState: authState,
                    team: home.team,
                    project: home.project,
                  ),
            ),
          ),
    );
  }
}
