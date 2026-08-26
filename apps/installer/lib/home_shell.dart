import 'package:catalog/auth/auth_state.dart';
import 'package:catalog/projects/projects_screen.dart';
import 'package:catalog/update_app.dart';
import 'package:flutter/material.dart';

/// Signed-in root: the app catalog and the team projects side by side.
class HomeShell extends StatefulWidget {
  const HomeShell({super.key, required this.authState});

  final AuthState authState;

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _index = 0;

  /// The projects tab is built on first visit so a launch does not walk every
  /// team's projects for a user who only installs apps.
  bool _projectsVisited = false;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: IndexedStack(
        index: _index,
        children: [
          UpdaterApp(authState: widget.authState),
          _projectsVisited
              ? ProjectsScreen(authState: widget.authState)
              : const SizedBox.shrink(),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected:
            (i) => setState(() {
              _index = i;
              if (i == 1) _projectsVisited = true;
            }),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.apps_rounded), label: '앱'),
          NavigationDestination(
            icon: Icon(Icons.bug_report_outlined),
            selectedIcon: Icon(Icons.bug_report_rounded),
            label: '프로젝트',
          ),
        ],
      ),
    );
  }
}
