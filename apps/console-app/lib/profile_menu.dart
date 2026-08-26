import 'package:flutter/material.dart';
import 'package:yyt_console/app_theme.dart';
import 'package:yyt_console/auth/auth_service.dart';
import 'package:yyt_console/auth/auth_state.dart';
import 'package:yyt_console/login_screen.dart';

/// App-bar avatar: switch between saved profiles, add one (QR), remove the
/// active one. Mirrors the account switcher of the Google apps.
class ProfileMenuButton extends StatelessWidget {
  const ProfileMenuButton({super.key, required this.authState});

  final AuthState authState;

  Future<void> _add(BuildContext context) async {
    await Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (_) => LoginScreen(authState: authState, pushed: true),
      ),
    );
  }

  Future<void> _remove(BuildContext context, Profile p) async {
    final ok = await showDialog<bool>(
      context: context,
      builder:
          (ctx) => AlertDialog(
            title: const Text('profile 제거'),
            content: Text(
              '${p.login} @ ${p.host} 을(를) 이 기기에서 제거합니다. '
              '콘솔의 API 토큰은 남아 있으니 필요하면 콘솔에서 revoke 하세요.',
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.of(ctx).pop(false),
                child: const Text('취소'),
              ),
              FilledButton(
                onPressed: () => Navigator.of(ctx).pop(true),
                child: const Text('제거'),
              ),
            ],
          ),
    );
    if (ok == true) await authState.removeProfile(p.id);
  }

  @override
  Widget build(BuildContext context) {
    final active = authState.activeProfile;
    if (active == null) return const SizedBox.shrink();
    return PopupMenuButton<String>(
      tooltip: 'profile',
      icon: ProfileAvatar(profile: active),
      onSelected: (value) {
        if (value == '_add') {
          _add(context);
        } else if (value == '_remove') {
          _remove(context, active);
        } else {
          authState.switchProfile(value);
        }
      },
      itemBuilder:
          (context) => [
            for (final p in authState.profiles)
              PopupMenuItem(
                value: p.id,
                child: ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: ProfileAvatar(profile: p, size: 28),
                  title: Text(p.login.isEmpty ? '(이름 없음)' : p.login),
                  subtitle: Text(p.host),
                  trailing:
                      p.id == active.id
                          ? const Icon(Icons.check_rounded, size: 18)
                          : null,
                ),
              ),
            const PopupMenuDivider(),
            const PopupMenuItem(
              value: '_add',
              child: ListTile(
                contentPadding: EdgeInsets.zero,
                leading: Icon(Icons.qr_code_scanner_rounded),
                title: Text('새 profile 추가'),
              ),
            ),
            const PopupMenuItem(
              value: '_remove',
              child: ListTile(
                contentPadding: EdgeInsets.zero,
                leading: Icon(Icons.person_remove_outlined),
                title: Text('이 profile 제거'),
              ),
            ),
          ],
    );
  }
}

class ProfileAvatar extends StatelessWidget {
  const ProfileAvatar({super.key, required this.profile, this.size = 32});

  final Profile profile;
  final double size;

  @override
  Widget build(BuildContext context) {
    final initial =
        profile.login.isEmpty ? '?' : profile.login[0].toUpperCase();
    return CircleAvatar(
      radius: size / 2,
      backgroundColor: CatalogPalette.ocean,
      child: Text(
        initial,
        style: TextStyle(
          color: Colors.white,
          fontSize: size * 0.45,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}
