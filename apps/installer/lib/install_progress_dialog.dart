import 'package:catalog/app_theme.dart';
import 'package:catalog/download_install_launch.dart';
import 'package:flutter/material.dart';

VoidCallback showInstallProgressDialog({
  required BuildContext context,
  required ValueNotifier<InstallProgress?> notifier,
  required InstallCancellationController cancellationController,
}) {
  BuildContext? dialogContext;
  var closed = false;

  void closeDialog() {
    if (closed) {
      return;
    }
    closed = true;
    final ctx = dialogContext;
    if (ctx != null && Navigator.of(ctx).canPop()) {
      Navigator.of(ctx).pop();
    }
    notifier.value = null;
  }

  showDialog<void>(
    context: context,
    barrierDismissible: false,
    builder: (context) {
      dialogContext = context;
      return ValueListenableBuilder<InstallProgress?>(
        valueListenable: notifier,
        builder: (context, progress, child) {
          final fraction = progress?.fraction;
          final percent = fraction == null ? null : (fraction * 100).round();
          final phaseLabel = _phaseLabel(progress?.phase);
          final canCancel = !_isTerminal(progress?.phase);

          return AlertDialog(
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(28),
            ),
            titlePadding: const EdgeInsets.fromLTRB(24, 24, 24, 12),
            contentPadding: const EdgeInsets.fromLTRB(24, 0, 24, 8),
            actionsPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
            title: Row(
              children: [
                Container(
                  width: 42,
                  height: 42,
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(14),
                    gradient: const LinearGradient(
                      colors: [CatalogPalette.ocean, CatalogPalette.ink],
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                    ),
                  ),
                  child: const Icon(
                    Icons.downloading_rounded,
                    color: Colors.white,
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    phaseLabel,
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                ),
              ],
            ),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(progress?.message ?? '준비 중입니다.'),
                const SizedBox(height: 16),
                ClipRRect(
                  borderRadius: BorderRadius.circular(999),
                  child: LinearProgressIndicator(
                    value: fraction,
                    minHeight: 10,
                  ),
                ),
                const SizedBox(height: 10),
                Row(
                  children: [
                    Text(
                      percent == null ? '진행률 계산 중' : '$percent%',
                      style: Theme.of(context).textTheme.bodyMedium,
                    ),
                    const Spacer(),
                    Text(
                      _phaseHint(progress?.phase),
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ),
              ],
            ),
            actions: [
              if (canCancel)
                TextButton(
                  onPressed: () {
                    cancellationController.cancel();
                    closeDialog();
                  },
                  child: Text(_cancelLabel(progress?.phase)),
                ),
            ],
          );
        },
      );
    },
  );

  return closeDialog;
}

String _cancelLabel(InstallPhase? phase) {
  if (phase == InstallPhase.downloading) {
    return '다운로드 취소';
  }
  return '중단';
}

String _phaseHint(InstallPhase? phase) {
  switch (phase) {
    case InstallPhase.downloading:
      return '네트워크 전송';
    case InstallPhase.downloaded:
      return '파일 준비 완료';
    case InstallPhase.installing:
      return '시스템 설치 화면';
    case InstallPhase.verifying:
      return '설치 결과 확인';
    case InstallPhase.uninstalling:
      return '기존 앱 삭제';
    case InstallPhase.reinstalling:
      return '선택 버전 재설치';
    case InstallPhase.done:
      return '완료';
    case null:
      return '';
  }
}

String _phaseLabel(InstallPhase? phase) {
  switch (phase) {
    case InstallPhase.downloading:
      return '다운로드 중';
    case InstallPhase.downloaded:
      return '파일 준비 완료';
    case InstallPhase.installing:
      return '설치 화면 여는 중';
    case InstallPhase.verifying:
      return '설치 확인 중';
    case InstallPhase.uninstalling:
      return '기존 앱 삭제 중';
    case InstallPhase.reinstalling:
      return '다시 설치 중';
    case InstallPhase.done:
      return '완료';
    case null:
      return '설치 준비 중';
  }
}

bool _isTerminal(InstallPhase? phase) {
  return phase == InstallPhase.done;
}
