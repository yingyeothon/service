import 'package:yyt_console/app_cards.dart';
import 'package:yyt_console/app_detail_view.dart';
import 'package:yyt_console/app_info.dart';
import 'package:yyt_console/app_install_state.dart';
import 'package:yyt_console/auth/auth_state.dart';
import 'package:yyt_console/install_button.dart';
import 'package:flutter/material.dart';

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
    return ListView.separated(
      itemCount: apps.length,
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      separatorBuilder: (_, _) => const SizedBox(height: 10),
      itemBuilder: (context, index) {
        final app = apps[index];
        final state = resolveAppInstallState(app.version, app.installedVersion);

        return AppSummaryCard(
          app: app,
          state: state,
          installedVersion: app.installedVersion,
          onTap: () async {
            await Navigator.push(
              context,
              MaterialPageRoute(
                builder:
                    (context) => AppDetailView(app: app, authState: authState),
              ),
            );
            await onAppsChanged();
          },
          action: InstallButton(
            state: state,
            app: app,
            onFinished: onAppsChanged,
          ),
        );
      },
    );
  }
}
