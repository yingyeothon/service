import 'package:yyt_console/external_launcher.dart';
import 'package:flutter/material.dart';

/// **열기**: launches the iOS app behind [scheme] (`url_scheme` tag). iOS
/// cannot tell the console whether the app is installed, so a failure is
/// the only answer: a SnackBar says it may be missing or the scheme differs.
class OpenAppButton extends StatelessWidget {
  const OpenAppButton({
    super.key,
    required this.scheme,
    this.launcher = launchExternal,
    this.compact = false,
  });

  final String scheme;
  final ExternalLauncher launcher;
  final bool compact;

  Future<void> _open(BuildContext context) async {
    final messenger = ScaffoldMessenger.of(context);
    if (await openAppByScheme(scheme, launcher: launcher)) return;
    messenger.showSnackBar(
      const SnackBar(
        content: Text(openAppFailedMessage),
        backgroundColor: Colors.red,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return OutlinedButton(
      onPressed: () => _open(context),
      style: compact
          ? OutlinedButton.styleFrom(
              minimumSize: const Size(48, 32),
              padding: const EdgeInsets.symmetric(horizontal: 12),
              visualDensity: VisualDensity.compact,
            )
          : null,
      child: const Text('열기'),
    );
  }
}
