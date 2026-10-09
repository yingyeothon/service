import 'dart:async';

import 'package:yyt_console/app_detail_view.dart';
import 'package:yyt_console/app_info.dart';
import 'package:yyt_console/auth/auth_state.dart';
import 'package:yyt_console/browse_screen.dart';
import 'package:yyt_console/fetch_remote_apps.dart';
import 'package:yyt_console/find_installed_version.dart';
import 'package:yyt_console/load_app_info.dart';
import 'package:yyt_console/projects/projects_screen.dart';
import 'package:yyt_console/push/push_service.dart';
import 'package:yyt_console/self_update_banner.dart';
import 'package:yyt_console/self_update_check.dart';
import 'package:yyt_console/update_app.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

/// Signed-in root: the app catalog and the team projects side by side.
class HomeShell extends StatefulWidget {
  const HomeShell({
    super.key,
    required this.authState,
    this.client,
    this.push,
    this.detailBuilder,
  });

  final AuthState authState;

  /// Tests pass one; otherwise the shell makes its own and closes it.
  final http.Client? client;

  /// Update notices (docs/push.md *Console app*); `null` = none, as in a
  /// build without the Firebase defines.
  final PushService? push;

  /// The screen a tapped notice opens; tests replace the real detail view.
  final Widget Function(AppInfo app)? detailBuilder;

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

  /// The first list load, then [_refreshBrowse]: what the update check waits
  /// for, so the launch stays one request at a time.
  late final Future<void> _launch = _firstLoad.future.then(
    (_) => _refreshBrowse(),
  );

  /// The profile this shell was built for: the scope its topics belong to.
  late final String? _scope = widget.authState.activeProfile?.id;

  /// The lists as last loaded, by source (`apps`, `browse`).
  final Map<String, List<AppInfo>> _loaded = {};

  /// Bumped to make the app tab reload (an update notice arrived).
  final ValueNotifier<int> _reload = ValueNotifier(0);
  StreamSubscription<CatalogPush>? _notices;
  bool _opening = false;

  @override
  void initState() {
    super.initState();
    final push = widget.push;
    if (push == null) return;
    _notices = push.foreground.listen(_onForegroundNotice);
    push.pendingOpen.addListener(_openPending);
    // A tap that started the app waits for the list, like the update check.
    _firstLoad.future.then((_) => _openPending());
  }

  @override
  void dispose() {
    _notices?.cancel();
    widget.push?.pendingOpen.removeListener(_openPending);
    _reload.dispose();
    if (widget.client == null) _client.close();
    super.dispose();
  }

  /// Reports the installed apps of one list: each is a topic to follow.
  void _onAppsLoaded(String source, List<AppInfo> apps) {
    _loaded[source] = apps;
    final scope = _scope;
    if (scope == null) return;
    widget.push?.sync(
      scope: scope,
      source: source,
      topics: {
        for (final app in apps)
          if (app.installedVersion != null)
            if (app.topic case final topic?) topic: app.id,
      },
    );
  }

  /// Once per launch, when an earlier launch followed an app through the
  /// browse tab and that tab is not open: reads the listings so an app
  /// removed in Android settings stops being followed without a visit to
  /// the tab. Nothing is requested for a user who follows none there.
  Future<void> _refreshBrowse() async {
    final push = widget.push;
    final scope = _scope;
    if (push == null || scope == null) return;
    try {
      if (!await push.follows(scope: scope, source: 'browse')) return;
      if (!mounted || _browseVisited) return;
      final token = widget.authState.token;
      final apps = await loadAppInfo(
        ({String? token}) => fetchPublicListings(token: token, client: _client),
        findInstalledVersion,
        token: token,
      );
      // The tab opened meanwhile: its own load is the newer one.
      if (!mounted || _loaded.containsKey('browse')) return;
      _onAppsLoaded('browse', apps);
    } catch (_) {
      // Offline or revoked: the next launch tries again.
    }
  }

  AppInfo? _known(String appId) {
    for (final list in _loaded.values) {
      for (final app in list) {
        if (app.id == appId) return app;
      }
    }
    return null;
  }

  /// A notice while the app is open: the system shows nothing, so say it
  /// here and refresh the list it is about.
  void _onForegroundNotice(CatalogPush p) {
    if (!mounted) return;
    final name = _known(p.appId)?.name ?? p.title ?? '앱';
    _reload.value++;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(foregroundNoticeText(name, p)),
        action: SnackBarAction(label: '보기', onPressed: () => _open(p)),
      ),
    );
  }

  void _openPending() {
    if (!mounted || !_firstLoad.isCompleted || _opening) return;
    final p = widget.push?.takePendingOpen();
    if (p != null) _open(p);
  }

  /// Opens the app's detail screen. The loaded list serves when it already
  /// shows the announced version (a cold start just loaded it); otherwise
  /// the lists are read again so the screen offers the new build.
  Future<void> _open(CatalogPush p) async {
    if (_opening) return;
    _opening = true;
    try {
      final known = _known(p.appId);
      final app =
          known != null && p.version.isNotEmpty && known.version == p.version
          ? known
          : await _fetch(p.appId) ?? known;
      if (!mounted) return;
      if (app == null) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('알림의 앱을 목록에서 찾지 못했습니다.')));
        return;
      }
      await Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) =>
              widget.detailBuilder?.call(app) ??
              AppDetailView(app: app, authState: widget.authState),
        ),
      );
      if (mounted) _reload.value++;
    } finally {
      _opening = false;
      // A second tap that arrived meanwhile is next.
      if (mounted && widget.push?.pendingOpen.value != null) _openPending();
    }
  }

  /// The app as the server lists it now: the member's own list, then the
  /// listings (an installed app the member only reads through a listing).
  Future<AppInfo?> _fetch(String appId) async {
    final token = widget.authState.token;
    for (final fetch in [fetchRemoteApps, fetchPublicListings]) {
      try {
        final apps = await loadAppInfo(
          ({String? token}) => fetch(token: token, client: _client),
          findInstalledVersion,
          token: token,
        );
        for (final app in apps) {
          if (app.id == appId) return app;
        }
      } catch (_) {
        // Offline or revoked: the loaded list, if any, is what is left.
        return null;
      }
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SelfUpdateBanner(
        authState: widget.authState,
        startAfter: _launch,
        check: ({required String? token}) =>
            checkConsoleAppUpdate(token: token, client: _client),
        child: IndexedStack(
          index: _index,
          children: [
            UpdaterApp(
              authState: widget.authState,
              client: _client,
              reload: _reload,
              onAppsLoaded: (apps) => _onAppsLoaded('apps', apps),
              onFirstLoadDone: () {
                if (!_firstLoad.isCompleted) _firstLoad.complete();
              },
            ),
            _browseVisited
                ? BrowseScreen(
                    authState: widget.authState,
                    client: _client,
                    onAppsLoaded: (apps) => _onAppsLoaded('browse', apps),
                  )
                : const SizedBox.shrink(),
            _projectsVisited
                ? ProjectsScreen(authState: widget.authState)
                : const SizedBox.shrink(),
          ],
        ),
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() {
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
