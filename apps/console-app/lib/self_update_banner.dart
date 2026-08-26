import 'package:yyt_console/app_info.dart';
import 'package:yyt_console/app_install_state.dart';
import 'package:yyt_console/app_theme.dart';
import 'package:yyt_console/auth/auth_state.dart';
import 'package:yyt_console/install_button.dart';
import 'package:yyt_console/self_update_check.dart';
import 'package:flutter/material.dart';

/// Checks once at launch whether the console serves a newer build of this
/// app and, if so, shows a banner with an update button above [child].
class SelfUpdateBanner extends StatefulWidget {
  const SelfUpdateBanner({
    super.key,
    required this.authState,
    required this.child,
    this.check = checkConsoleAppUpdate,
  });

  final AuthState authState;
  final Widget child;
  final Future<ConsoleAppUpdate?> Function({required String? token}) check;

  @override
  State<SelfUpdateBanner> createState() => _SelfUpdateBannerState();
}

class _SelfUpdateBannerState extends State<SelfUpdateBanner> {
  ConsoleAppUpdate? _update;
  bool _dismissed = false;

  @override
  void initState() {
    super.initState();
    _run();
  }

  Future<void> _run() async {
    final update = await widget.check(token: widget.authState.token);
    if (!mounted || update == null) return;
    setState(() => _update = update);
  }

  @override
  Widget build(BuildContext context) {
    final update = _update;
    if (update == null || _dismissed) return widget.child;
    final app = AppInfo(
      id: update.artifact.id,
      name: '잉여톤',
      package: update.packageName,
      description: '',
      latestArtifact: update.artifact,
      installedVersion: update.installedVersion,
      needsUpdate: true,
    );
    return Column(
      children: [
        Material(
          color: CatalogPalette.sunrise,
          child: SafeArea(
            bottom: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 10, 8, 10),
              child: Row(
                children: [
                  const Icon(
                    Icons.system_update_rounded,
                    color: CatalogPalette.ink,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      '새 버전 ${update.version} 이 있습니다 (현재 ${update.installedVersion})',
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        color: CatalogPalette.ink,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  InstallButton(
                    state: AppInstallState.old,
                    app: app,
                    label: '업데이트',
                  ),
                  IconButton(
                    tooltip: '닫기',
                    icon: const Icon(Icons.close_rounded),
                    onPressed: () => setState(() => _dismissed = true),
                  ),
                ],
              ),
            ),
          ),
        ),
        // The child's own AppBar pads for the status bar again unless the
        // inset the banner already consumed is removed.
        Expanded(
          child: MediaQuery.removePadding(
            context: context,
            removeTop: true,
            child: widget.child,
          ),
        ),
      ],
    );
  }
}
