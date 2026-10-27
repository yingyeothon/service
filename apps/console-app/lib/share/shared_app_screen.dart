import 'dart:async';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:yyt_console/artifact_info.dart';
import 'package:yyt_console/auth/app_handoff.dart';
import 'package:yyt_console/catalog_platform.dart';
import 'package:yyt_console/check_if_need_to_update.dart';
import 'package:yyt_console/download_install_launch.dart';
import 'package:yyt_console/find_installed_version.dart';
import 'package:yyt_console/format_bytes.dart';
import 'package:yyt_console/format_time.dart';
import 'package:yyt_console/install_progress_dialog.dart';
import 'package:yyt_console/share/share_models.dart';

/// What a share link opens (docs/decisions.md *Catalog share links* #7):
/// the JSON twin of `/i/{ref}`, read without credentials, and an install of
/// the newest build for this device through the app's own install flow. It
/// works signed out: `main.dart` pushes it above the login screen.
class SharedAppScreen extends StatefulWidget {
  const SharedAppScreen({
    super.key,
    required this.link,
    this.client,
    this.findInstalledVersionFn = findInstalledVersion,
  });

  final ShareLink link;

  /// Injected by tests; otherwise one client per screen.
  final http.Client? client;
  final Future<String?> Function(String packageName) findInstalledVersionFn;

  @override
  State<SharedAppScreen> createState() => _SharedAppScreenState();
}

class _SharedAppScreenState extends State<SharedAppScreen>
    with WidgetsBindingObserver {
  late final http.Client _client = widget.client ?? http.Client();
  bool _loading = true;
  bool _unavailable = false;
  String? _error;
  SharedApp? _app;
  String? _installedVersion;

  bool _installing = false;
  final _progress = ValueNotifier<InstallProgress?>(null);
  Completer<void>? _installerReturn;
  bool _leftForInstaller = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _load();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _progress.dispose();
    if (widget.client == null) _client.close();
    super.dispose();
  }

  // Same rule as the app detail screen: `resumed` counts as back from the
  // installer only after the app actually went away.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final completer = _installerReturn;
    if (completer == null) return;
    if (state != AppLifecycleState.resumed) {
      _leftForInstaller = true;
      return;
    }
    if (!_leftForInstaller || completer.isCompleted) return;
    completer.complete();
    _installerReturn = null;
  }

  Future<void> _beginInstallerReturnWatch() {
    final completer = Completer<void>();
    _leftForInstaller = false;
    _installerReturn = completer;
    return completer.future;
  }

  ArtifactInfo? get _installable {
    final app = _app;
    if (app == null) return null;
    return isIosDevice() ? app.installableIos : app.installableAndroid;
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
      _unavailable = false;
    });
    try {
      final app = await fetchSharedApp(
        server: widget.link.server,
        ref: widget.link.ref,
        client: _client,
      );
      if (!mounted) return;
      _app = app;
      final installed = await _readInstalledVersion();
      if (!mounted) return;
      setState(() {
        _installedVersion = installed;
        _loading = false;
      });
    } on ShareUnavailableException {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _unavailable = true;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        // A fetch failure carries its own message; anything else (a malformed
        // body) gets a plain one, never a Dart `Exception: ` prefix.
        _error = e is ShareFetchException ? e.message : '공유 정보 응답을 읽을 수 없습니다.';
      });
    }
  }

  Future<String?> _readInstalledVersion() async {
    final a = _installable;
    if (a == null || a.installId.isEmpty) return null;
    try {
      return await widget.findInstalledVersionFn(a.installId);
    } catch (_) {
      return null;
    }
  }

  Future<void> _install(ArtifactInfo artifact) async {
    if (_installing) return;
    setState(() => _installing = true);
    final cancel = InstallCancellationController();
    final closeDialog = showInstallProgressDialog(
      context: context,
      notifier: _progress,
      cancellationController: cancel,
    );
    final packageName = artifact.installId;
    try {
      final attempt = await installArtifact(
        artifactUrl: artifact.url,
        packageName: packageName,
        targetVersion: artifact.comparableVersion,
        installedVersionBefore: _installedVersion,
        beginInstallerReturnWatch: _beginInstallerReturnWatch,
        cancellationController: cancel,
        onProgress: (p) => _progress.value = p,
        artifact: artifact,
        // No update-notice subscription for a link recipient (decision).
        topic: null,
      );
      if (!mounted) return;
      if (attempt.needsDowngradeFallback && attempt.downloadedPath != null) {
        closeDialog();
        if (!await _confirmDowngrade() || !mounted) return;
        final again = showInstallProgressDialog(
          context: context,
          notifier: _progress,
          cancellationController: cancel,
        );
        try {
          final r = await reinstallAfterUninstall(
            downloadedPath: attempt.downloadedPath!,
            packageName: packageName,
            targetVersion: artifact.comparableVersion,
            beginInstallerReturnWatch: _beginInstallerReturnWatch,
            cancellationController: cancel,
            onProgress: (p) => _progress.value = p,
          );
          _snack(r.message, isError: !r.success && !r.cancelledByUser);
        } finally {
          again();
        }
      } else {
        _snack(
          attempt.message,
          isError: !attempt.success && !attempt.cancelledByUser,
        );
      }
    } catch (e) {
      if (mounted) _snack('설치 실패: $e', isError: true);
    } finally {
      _installerReturn = null;
      closeDialog();
      if (mounted) {
        final installed = await _readInstalledVersion();
        if (mounted) {
          setState(() {
            _installing = false;
            _installedVersion = installed;
          });
        }
      }
    }
  }

  Future<bool> _confirmDowngrade() async =>
      await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('다운그레이드 재설치 필요'),
          content: const Text(
            '현재 버전이 더 높아 직접 설치가 실패했습니다.\n기존 앱을 삭제한 뒤 재설치할까요?',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('취소'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('삭제 후 재설치'),
            ),
          ],
        ),
      ) ??
      false;

  void _snack(String message, {bool isError = false}) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        backgroundColor: isError ? Colors.red : null,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(_app?.title ?? '공유된 앱')),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(16),
          children: _body(context),
        ),
      ),
    );
  }

  List<Widget> _body(BuildContext context) {
    final theme = Theme.of(context);
    if (_loading) {
      return const [
        SizedBox(height: 160),
        Center(child: CircularProgressIndicator()),
      ];
    }
    if (_unavailable) {
      return [
        const SizedBox(height: 120),
        Icon(Icons.link_off_rounded, size: 48, color: theme.hintColor),
        const SizedBox(height: 12),
        Text(
          '링크를 사용할 수 없습니다',
          textAlign: TextAlign.center,
          style: theme.textTheme.titleMedium,
        ),
        const SizedBox(height: 8),
        const Text(
          '링크가 만료되었거나 회수되었을 수 있습니다. 링크를 보낸 사람에게 새 링크를 요청하세요.',
          textAlign: TextAlign.center,
        ),
      ];
    }
    if (_error case final e?) {
      return [
        const SizedBox(height: 120),
        Icon(Icons.error_outline_rounded, size: 48, color: theme.hintColor),
        const SizedBox(height: 12),
        Text(
          '공유 정보를 불러오지 못했습니다',
          textAlign: TextAlign.center,
          style: theme.textTheme.titleMedium,
        ),
        const SizedBox(height: 8),
        Text(e, textAlign: TextAlign.center),
        const SizedBox(height: 12),
        Center(
          child: OutlinedButton(onPressed: _load, child: const Text('다시 시도')),
        ),
      ];
    }
    final app = _app!;
    final artifact = _installable;
    final expires = app.expiresAt;
    final installed = _installedVersion;
    return [
      Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(app.title, style: theme.textTheme.titleLarge),
              if (app.title != app.appName && app.appName.isNotEmpty)
                Text(app.appName, style: theme.textTheme.bodySmall),
              const SizedBox(height: 8),
              if (app.teamName case final team?) Text('팀: $team'),
              if (artifact != null) Text('버전: ${artifact.comparableVersion}'),
              if (artifact != null && artifact.size > 0)
                Text('크기: ${formatBytes(artifact.size)}'),
              if (expires != null)
                Text('링크 만료: ${formatLocalTime(expires)}')
              else
                const Text('공개 링크'),
              if (installed != null) Text('설치된 버전: $installed'),
              if (app.summary case final s? when s.trim().isNotEmpty) ...[
                const SizedBox(height: 12),
                Text(s),
              ],
            ],
          ),
        ),
      ),
      const SizedBox(height: 16),
      if (artifact == null)
        Text(
          isIosDevice()
              ? '이 기기(iOS)에 설치할 수 있는 빌드가 없습니다.'
              : '이 기기(Android)에 설치할 수 있는 APK 빌드가 없습니다.',
          textAlign: TextAlign.center,
        )
      else if (!artifact.isIos && artifact.installId.isEmpty)
        // Without its applicationId the install cannot be verified.
        const Text(
          '이 빌드에는 패키지 정보(application_id)가 없어 앱에서 설치할 수 없습니다.',
          textAlign: TextAlign.center,
        )
      else ...[
        FilledButton.icon(
          onPressed: _installing ? null : () => _install(artifact),
          icon: const Icon(Icons.download_rounded),
          label: Text(_installLabel(artifact, installed)),
        ),
        if (artifact.isIos) ...[
          const SizedBox(height: 8),
          Text(
            '등록된 기기에서만 설치됩니다. 설치는 홈 화면에서 진행됩니다.',
            textAlign: TextAlign.center,
            style: theme.textTheme.bodySmall,
          ),
        ],
      ],
    ];
  }

  static String _installLabel(ArtifactInfo a, String? installed) {
    if (installed == null) return '설치';
    if (isSameVersion(a.comparableVersion, installed)) return '다시 설치';
    return checkIfNeedToUpdate(a.comparableVersion, installed) ? '업데이트' : '설치';
  }
}
