import 'package:yyt_console/app_cards.dart';
import 'package:yyt_console/app_detail_view.dart';
import 'package:yyt_console/app_info.dart';
import 'package:yyt_console/app_install_state.dart';
import 'package:yyt_console/auth/auth_state.dart';
import 'package:yyt_console/install_button.dart';
import 'package:flutter/material.dart';

/// The catalog as a grid of small cards (see [appGridColumns]).
class AppListView extends StatelessWidget {
  const AppListView({
    super.key,
    required this.apps,
    required this.authState,
    required this.onAppsChanged,
  });

  final List<AppInfo> apps;
  final AuthState authState;
  final Future<void> Function() onAppsChanged;

  @override
  Widget build(BuildContext context) {
    final columns = appGridColumns(MediaQuery.sizeOf(context));
    final rows = <Widget>[];
    for (var start = 0; start < apps.length; start += columns) {
      final cells = <Widget>[];
      for (var i = 0; i < columns; i += 1) {
        final index = start + i;
        if (i > 0) cells.add(const SizedBox(width: 8));
        cells.add(
          Expanded(
            child:
                index < apps.length
                    ? _cell(context, apps[index])
                    : const SizedBox.shrink(),
          ),
        );
      }
      if (start > 0) rows.add(const SizedBox(height: 8));
      // IntrinsicHeight keeps the cards of a row equally tall without the
      // fixed aspect ratio a GridView would force on 2-line descriptions.
      rows.add(
        IntrinsicHeight(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: cells,
          ),
        ),
      );
    }
    return Column(children: rows);
  }

  Widget _cell(BuildContext context, AppInfo app) {
    final state = resolveAppInstallState(app.version, app.installedVersion);
    return AppGridCard(
      // Keyed so an in-flight install's spinner follows its app when the
      // search filter reflows the grid.
      key: ValueKey<String>(app.id),
      app: app,
      state: state,
      onTap: () async {
        await Navigator.push(
          context,
          MaterialPageRoute(
            builder: (context) => AppDetailView(app: app, authState: authState),
          ),
        );
        await onAppsChanged();
      },
      action: InstallButton(
        state: state,
        app: app,
        onFinished: onAppsChanged,
        compact: true,
      ),
    );
  }
}
