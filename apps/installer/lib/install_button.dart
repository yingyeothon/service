import 'dart:async';

import 'package:catalog/app_info.dart';
import 'package:catalog/app_install_state.dart';
import 'package:catalog/download_install_launch.dart';
import 'package:catalog/install_progress_dialog.dart';
import 'package:flutter/material.dart';

class InstallButton extends StatefulWidget {
  const InstallButton({
    super.key,
    required this.state,
    required this.app,
    this.onFinished,
  });

  final AppInstallState state;
  final AppInfo app;
  final Future<void> Function()? onFinished;

  @override
  State<InstallButton> createState() => _InstallButtonState();
}

class _InstallButtonState extends State<InstallButton>
    with WidgetsBindingObserver {
  bool _running = false;
  Completer<void>? _installerReturnCompleter;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) {
      return;
    }

    final completer = _installerReturnCompleter;
    if (completer == null || completer.isCompleted) {
      return;
    }

    completer.complete();
    _installerReturnCompleter = null;
  }

  @override
  Widget build(BuildContext context) {
    final installable = widget.app.latestArtifact.isInstallableAndroidApk;
    final disabled = _running || !installable;
    final label =
        installable
            ? widget.state == AppInstallState.latest
                ? '재설치'
                : '설치'
            : '설치 불가';

    return FilledButton(
      onPressed: disabled ? null : _onPressed,
      child:
          _running
              ? const SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
              : Text(label),
    );
  }

  Future<void> _onPressed() async {
    setState(() {
      _running = true;
    });

    try {
      final attempt = await _runInstallAttempt();
      if (!mounted) return;

      if (attempt.success) {
        _showSnack(attempt.message);
        return;
      }

      if (attempt.cancelledByUser) {
        _showSnack(attempt.message);
        return;
      }

      if (!attempt.needsDowngradeFallback || attempt.downloadedPath == null) {
        _showSnack(attempt.message, isError: true);
        return;
      }

      final confirmed = await _confirmDowngradeFallback();
      if (!mounted || !confirmed) {
        return;
      }

      final reinstall = await _runReinstallAttempt(attempt.downloadedPath!);
      if (!mounted) return;
      _showSnack(
        reinstall.message,
        isError: !reinstall.success && !reinstall.cancelledByUser,
      );
    } catch (e) {
      if (!mounted) return;
      _showSnack('설치 실패: $e', isError: true);
    } finally {
      if (mounted) {
        setState(() {
          _running = false;
        });
      }
      await widget.onFinished?.call();
    }
  }

  Future<InstallAttemptResult> _runInstallAttempt() async {
    final notifier = ValueNotifier<InstallProgress?>(null);
    final cancellationController = InstallCancellationController();
    final closeDialog = showInstallProgressDialog(
      context: context,
      notifier: notifier,
      cancellationController: cancellationController,
    );

    try {
      return await installArtifact(
        artifactUrl: widget.app.apkUrl,
        packageName: widget.app.applicationId,
        targetVersion: widget.app.version,
        installedVersionBefore: widget.app.installedVersion,
        beginInstallerReturnWatch: _beginInstallerReturnWatch,
        cancellationController: cancellationController,
        onProgress: (progress) {
          notifier.value = progress;
        },
      );
    } finally {
      _installerReturnCompleter = null;
      closeDialog();
      notifier.dispose();
    }
  }

  Future<InstallAttemptResult> _runReinstallAttempt(
    String downloadedPath,
  ) async {
    final notifier = ValueNotifier<InstallProgress?>(null);
    final cancellationController = InstallCancellationController();
    final closeDialog = showInstallProgressDialog(
      context: context,
      notifier: notifier,
      cancellationController: cancellationController,
    );

    try {
      return await reinstallAfterUninstall(
        downloadedPath: downloadedPath,
        packageName: widget.app.applicationId,
        targetVersion: widget.app.version,
        beginInstallerReturnWatch: _beginInstallerReturnWatch,
        cancellationController: cancellationController,
        onProgress: (progress) {
          notifier.value = progress;
        },
      );
    } finally {
      _installerReturnCompleter = null;
      closeDialog();
      notifier.dispose();
    }
  }

  Future<void> _beginInstallerReturnWatch() {
    final completer = Completer<void>();
    _installerReturnCompleter = completer;
    return completer.future;
  }

  Future<bool> _confirmDowngradeFallback() async {
    final result = await showDialog<bool>(
      context: context,
      builder: (context) {
        return AlertDialog(
          title: const Text('다운그레이드 재설치 필요'),
          content: const Text(
            '현재 설치된 버전이 더 높아 직접 덮어쓰기 설치가 실패했습니다.\n기존 앱을 삭제한 뒤 선택한 버전으로 재설치할까요?',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('취소'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('삭제 후 재설치'),
            ),
          ],
        );
      },
    );
    return result ?? false;
  }

  void _showSnack(String message, {bool isError = false}) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        backgroundColor: isError ? Colors.red : null,
      ),
    );
  }
}
