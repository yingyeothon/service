import 'dart:async';

import 'package:yyt_console/auth/auth_state.dart';
import 'package:yyt_console/browse_screen.dart';
import 'package:yyt_console/projects/projects_screen.dart';
import 'package:yyt_console/self_update_banner.dart';
import 'package:yyt_console/self_update_check.dart';
import 'package:yyt_console/update_app.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

/// Signed-in root: the app catalog and the team projects side by side.
class HomeShell extends StatefulWidget {
  const HomeShell({super.key, required this.authState, this.client});

  final AuthState authState;

  /// Tests pass one; otherwise the shell makes its own and closes it.
  final http.Client? client;

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _index = 0;

  /// The projects tab is built on first visit so a launch does not walk every
  /// team's projects for a user who only installs apps.
  bool _projectsVisited = false;

  /// Same for the browse tab: its list is a second request.
  bool _browseVisited = false;

  /// One connection for the launch requests — the list, then the update
  /// check — closed with the profile: HomeShell is keyed by profile id.
  late final http.Client _client = widget.client ?? http.Client();

  /// Completes when the first list load has ended, whatever its outcome; the
  /// update check waits for it so the launch is one request at a time.
  final Completer<void> _firstLoad = Completer<void>();

  @override
  void dispose() {
    if (widget.client == null) _client.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SelfUpdateBanner(
        authState: widget.authState,
        startAfter: _firstLoad.future,
        check:
            ({required String? token}) =>
                checkConsoleAppUpdate(token: token, client: _client),
        child: IndexedStack(
          index: _index,
          children: [
            UpdaterApp(
              authState: widget.authState,
              client: _client,
              onFirstLoadDone: () {
                if (!_firstLoad.isCompleted) _firstLoad.complete();
              },
            ),
            _browseVisited
                ? BrowseScreen(authState: widget.authState, client: _client)
                : const SizedBox.shrink(),
            _projectsVisited
                ? ProjectsScreen(authState: widget.authState)
                : const SizedBox.shrink(),
          ],
        ),
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected:
            (i) => setState(() {
              _index = i;
              if (i == 1) _browseVisited = true;
              if (i == 2) _projectsVisited = true;
            }),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.apps_rounded), label: '앱'),
          NavigationDestination(
            icon: Icon(Icons.storefront_outlined),
            selectedIcon: Icon(Icons.storefront_rounded),
            label: '둘러보기',
          ),
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
