import 'package:flutter/material.dart';
import 'package:yyt_console/auth/app_handoff.dart';
import 'package:yyt_console/share/shared_app_screen.dart';

/// Names the [SharedAppScreen] route so an auth change can spare it.
const sharedAppRouteName = 'shared-app';

Route<void> sharedAppRoute(ShareLink link) => MaterialPageRoute<void>(
  settings: const RouteSettings(name: sharedAppRouteName),
  builder: (_) => SharedAppScreen(link: link),
);

bool _isShare(Route<dynamic> r) => r.settings.name == sharedAppRouteName;

/// The navigator's routes, bottom first. `Navigator` keeps its stack
/// private; this mirrors it for [popToRootKeepingShares].
class RouteStackObserver extends NavigatorObserver {
  final List<Route<dynamic>> routes = <Route<dynamic>>[];

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) =>
      routes.add(route);

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) =>
      routes.remove(route);

  @override
  void didRemove(Route<dynamic> route, Route<dynamic>? previousRoute) =>
      routes.remove(route);

  @override
  void didReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) {
    final i = oldRoute == null ? -1 : routes.indexOf(oldRoute);
    if (newRoute == null) return;
    if (i < 0) {
      routes.add(newRoute);
    } else {
      routes[i] = newRoute;
    }
  }
}

/// A profile switch drops the previous profile's screens (issue detail, app
/// detail) but not a share screen: it reads no profile, and closing it would
/// lose a link the user just opened (a stale profile's 401 on a cold start,
/// a handoff accepted on top). Routes above the topmost share screen are its
/// own dialogs (install progress) and stay too.
void popToRootKeepingShares(NavigatorState nav, List<Route<dynamic>> stack) {
  final top = stack.lastIndexWhere(_isShare);
  if (top < 0) {
    nav.popUntil((route) => route.isFirst);
    return;
  }
  for (final r in stack.sublist(1, top).toList()) {
    if (!_isShare(r)) nav.removeRoute(r);
  }
}
