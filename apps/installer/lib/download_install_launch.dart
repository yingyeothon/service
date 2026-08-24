import 'dart:async';
import 'dart:io';

import 'package:catalog/check_if_need_to_update.dart';
import 'package:catalog/device_apps.dart';
import 'package:catalog/find_installed_version.dart';
import 'package:catalog/self_update_state.dart';
import 'package:dio/dio.dart';
import 'package:open_filex/open_filex.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

enum InstallPhase {
  downloading,
  downloaded,
  installing,
  verifying,
  uninstalling,
  reinstalling,
  done,
}

class InstallProgress {
  InstallProgress({required this.phase, required this.message, this.fraction});

  final InstallPhase phase;
  final String message;
  final double? fraction;
}

class InstallCancellationController {
  final CancelToken _downloadCancelToken = CancelToken();
  final Completer<void> _cancelled = Completer<void>();

  bool get isCancelled => _cancelled.isCompleted;
  Future<void> get whenCancelled => _cancelled.future;
  CancelToken get downloadCancelToken => _downloadCancelToken;

  void cancel() {
    if (_cancelled.isCompleted) {
      return;
    }
    _downloadCancelToken.cancel('cancelled-by-user');
    _cancelled.complete();
  }
}

class InstallCancelledException implements Exception {
  const InstallCancelledException(this.message);

  final String message;

  @override
  String toString() => message;
}

class InstallAttemptResult {
  InstallAttemptResult({
    required this.success,
    required this.installedVersion,
    required this.needsDowngradeFallback,
    required this.downloadedPath,
    required this.message,
    required this.cancelledByUser,
  });

  final bool success;
  final String? installedVersion;
  final bool needsDowngradeFallback;
  final String? downloadedPath;
  final String message;
  final bool cancelledByUser;
}

class InstallVerificationResult {
  InstallVerificationResult({
    required this.installedVersion,
    required this.cancelledByUser,
  });

  final String? installedVersion;
  final bool cancelledByUser;
}

Future<InstallAttemptResult> installArtifact({
  required String artifactUrl,
  required String packageName,
  required String targetVersion,
  String? installedVersionBefore,
  required void Function(InstallProgress progress) onProgress,
  Future<void> Function()? beginInstallerReturnWatch,
  Duration verifyTimeout = const Duration(seconds: 70),
  InstallCancellationController? cancellationController,
  Future<String?> Function(String packageName) findInstalledVersionFn =
      findInstalledVersion,
  Future<bool> Function(String packageName) isSelfUpdatePackageFn =
      isSelfUpdatePackage,
  Future<void> Function(String targetVersion) markPendingSelfUpdateFn =
      markPendingSelfUpdate,
}) async {
  String? downloadedPath;

  try {
    var selfUpdate = false;
    try {
      selfUpdate = await isSelfUpdatePackageFn(packageName);
    } catch (_) {
      selfUpdate = false;
    }

    if (selfUpdate && isDowngrade(targetVersion, installedVersionBefore)) {
      return InstallAttemptResult(
        success: false,
        installedVersion: installedVersionBefore,
        needsDowngradeFallback: false,
        downloadedPath: null,
        message: 'installer 자체 다운그레이드는 지원하지 않습니다.',
        cancelledByUser: false,
      );
    }

    _throwIfCancelled(cancellationController, '설치를 취소했습니다.');
    downloadedPath = await _downloadArtifact(
      artifactUrl: artifactUrl,
      packageName: packageName,
      onProgress: onProgress,
      cancellationController: cancellationController,
    );
    _throwIfCancelled(cancellationController, '설치를 취소했습니다.');

    onProgress(
      InstallProgress(
        phase: InstallPhase.downloaded,
        message: '다운로드 완료',
        fraction: 1,
      ),
    );

    final installerReturned = beginInstallerReturnWatch?.call();
    final opened = await _openInstaller(downloadedPath);
    if (!opened) {
      return InstallAttemptResult(
        success: false,
        installedVersion: installedVersionBefore,
        needsDowngradeFallback: false,
        downloadedPath: downloadedPath,
        message: '설치 화면을 열 수 없습니다.',
        cancelledByUser: false,
      );
    }

    _throwIfCancelled(cancellationController, '설치를 취소했습니다.');
    if (selfUpdate) {
      await markPendingSelfUpdateFn(targetVersion);
      return InstallAttemptResult(
        success: true,
        installedVersion: installedVersionBefore,
        needsDowngradeFallback: false,
        downloadedPath: downloadedPath,
        message: '설치 화면을 열었습니다. 설치 후 앱을 다시 열어주세요.',
        cancelledByUser: false,
      );
    }

    onProgress(
      InstallProgress(
        phase: InstallPhase.installing,
        message: '설치 중입니다. 시스템 설치 화면에서 계속 진행해주세요.',
      ),
    );

    final verification = await waitForInstalledVersion(
      packageName: packageName,
      targetVersion: targetVersion,
      timeout: verifyTimeout,
      installerReturned: installerReturned,
      waitForInstallerReturnBeforeAcceptingVersion: isSameVersion(
        targetVersion,
        installedVersionBefore,
      ),
      onProgress: onProgress,
      cancellationController: cancellationController,
      findInstalledVersionFn: findInstalledVersionFn,
    );
    final verifiedVersion = verification.installedVersion;

    if (isSameVersion(targetVersion, verifiedVersion)) {
      return InstallAttemptResult(
        success: true,
        installedVersion: verifiedVersion,
        needsDowngradeFallback: false,
        downloadedPath: downloadedPath,
        message: '설치 완료',
        cancelledByUser: false,
      );
    }

    if (verification.cancelledByUser) {
      return InstallAttemptResult(
        success: false,
        installedVersion: verifiedVersion,
        needsDowngradeFallback: false,
        downloadedPath: downloadedPath,
        message: '설치를 취소했습니다.',
        cancelledByUser: true,
      );
    }

    final downgradeFallback =
        isDowngrade(targetVersion, installedVersionBefore) &&
        !isSameVersion(targetVersion, verifiedVersion);

    return InstallAttemptResult(
      success: false,
      installedVersion: verifiedVersion,
      needsDowngradeFallback: downgradeFallback,
      downloadedPath: downloadedPath,
      message: downgradeFallback ? '다운그레이드 설치 실패' : '설치 완료를 확인하지 못했습니다.',
      cancelledByUser: false,
    );
  } on InstallCancelledException catch (e) {
    return InstallAttemptResult(
      success: false,
      installedVersion: await findInstalledVersionFn(packageName),
      needsDowngradeFallback: false,
      downloadedPath: downloadedPath,
      message: e.message,
      cancelledByUser: true,
    );
  }
}

Future<InstallAttemptResult> reinstallAfterUninstall({
  required String downloadedPath,
  required String packageName,
  required String targetVersion,
  required void Function(InstallProgress progress) onProgress,
  Future<void> Function()? beginInstallerReturnWatch,
  Duration uninstallTimeout = const Duration(seconds: 90),
  Duration verifyTimeout = const Duration(seconds: 70),
  InstallCancellationController? cancellationController,
  Future<String?> Function(String packageName) findInstalledVersionFn =
      findInstalledVersion,
}) async {
  try {
    _throwIfCancelled(cancellationController, '재설치를 취소했습니다.');
    onProgress(
      InstallProgress(
        phase: InstallPhase.uninstalling,
        message: '기존 앱 삭제 중입니다. 시스템 화면에서 삭제를 완료해주세요.',
      ),
    );

    final launched = await DeviceApps.uninstallApp(packageName);
    if (!launched) {
      return InstallAttemptResult(
        success: false,
        installedVersion: await findInstalledVersionFn(packageName),
        needsDowngradeFallback: false,
        downloadedPath: downloadedPath,
        message: '삭제 화면을 열지 못했습니다.',
        cancelledByUser: false,
      );
    }

    final uninstalled = await waitForPackageUninstalled(
      packageName: packageName,
      timeout: uninstallTimeout,
      cancellationController: cancellationController,
    );
    if (!uninstalled) {
      return InstallAttemptResult(
        success: false,
        installedVersion: await findInstalledVersionFn(packageName),
        needsDowngradeFallback: false,
        downloadedPath: downloadedPath,
        message: '앱 삭제 완료를 확인하지 못했습니다.',
        cancelledByUser: false,
      );
    }

    _throwIfCancelled(cancellationController, '재설치를 취소했습니다.');
    onProgress(
      InstallProgress(
        phase: InstallPhase.reinstalling,
        message: '구버전 재설치 중입니다.',
      ),
    );

    final installerReturned = beginInstallerReturnWatch?.call();
    final opened = await _openInstaller(downloadedPath);
    if (!opened) {
      return InstallAttemptResult(
        success: false,
        installedVersion: await findInstalledVersionFn(packageName),
        needsDowngradeFallback: false,
        downloadedPath: downloadedPath,
        message: '재설치 화면을 열 수 없습니다.',
        cancelledByUser: false,
      );
    }

    final verification = await waitForInstalledVersion(
      packageName: packageName,
      targetVersion: targetVersion,
      timeout: verifyTimeout,
      installerReturned: installerReturned,
      onProgress: onProgress,
      cancellationController: cancellationController,
      findInstalledVersionFn: findInstalledVersionFn,
    );
    final verified = verification.installedVersion;

    if (verification.cancelledByUser) {
      return InstallAttemptResult(
        success: false,
        installedVersion: verified,
        needsDowngradeFallback: false,
        downloadedPath: downloadedPath,
        message: '재설치를 취소했습니다.',
        cancelledByUser: true,
      );
    }

    return InstallAttemptResult(
      success: isSameVersion(targetVersion, verified),
      installedVersion: verified,
      needsDowngradeFallback: false,
      downloadedPath: downloadedPath,
      message:
          isSameVersion(targetVersion, verified)
              ? '재설치 완료'
              : '재설치 완료를 확인하지 못했습니다.',
      cancelledByUser: false,
    );
  } on InstallCancelledException catch (e) {
    return InstallAttemptResult(
      success: false,
      installedVersion: await findInstalledVersionFn(packageName),
      needsDowngradeFallback: false,
      downloadedPath: downloadedPath,
      message: e.message,
      cancelledByUser: true,
    );
  }
}

Future<InstallVerificationResult> waitForInstalledVersion({
  required String packageName,
  required String targetVersion,
  required Duration timeout,
  required void Function(InstallProgress progress) onProgress,
  Future<void>? installerReturned,
  bool waitForInstallerReturnBeforeAcceptingVersion = false,
  Duration pollInterval = const Duration(seconds: 2),
  InstallCancellationController? cancellationController,
  Future<String?> Function(String packageName) findInstalledVersionFn =
      findInstalledVersion,
}) async {
  const cancelMessage = '설치를 취소했습니다.';

  onProgress(
    InstallProgress(phase: InstallPhase.verifying, message: '설치 결과 확인 중...'),
  );

  var returnedToApp = false;
  var resetDeadlineAfterReturn = false;
  Future<void>? returnSignal;
  if (installerReturned != null) {
    returnSignal = installerReturned
        .then((_) {
          returnedToApp = true;
          resetDeadlineAfterReturn = true;
        })
        .catchError((_) {
          // Ignore signal errors and let regular verification continue.
        });
  }

  var endAt = DateTime.now().add(timeout);
  while (true) {
    _throwIfCancelled(cancellationController, cancelMessage);

    if (resetDeadlineAfterReturn) {
      endAt = DateTime.now().add(timeout);
      resetDeadlineAfterReturn = false;
    }

    final installed = await findInstalledVersionFn(packageName);
    _throwIfCancelled(cancellationController, cancelMessage);
    final canAcceptInstalledVersion =
        !waitForInstallerReturnBeforeAcceptingVersion ||
        returnSignal == null ||
        returnedToApp;
    if (canAcceptInstalledVersion && isSameVersion(targetVersion, installed)) {
      return InstallVerificationResult(
        installedVersion: installed,
        cancelledByUser: false,
      );
    }

    final now = DateTime.now();
    final deadlineActive = returnSignal == null || returnedToApp;

    if (deadlineActive && !now.isBefore(endAt)) {
      return InstallVerificationResult(
        installedVersion: installed,
        cancelledByUser: false,
      );
    }

    final waitUntilCandidates = <DateTime>[now.add(pollInterval)];
    if (deadlineActive) {
      waitUntilCandidates.add(endAt);
    }

    DateTime nextWakeup = waitUntilCandidates.first;
    for (final candidate in waitUntilCandidates.skip(1)) {
      if (candidate.isBefore(nextWakeup)) {
        nextWakeup = candidate;
      }
    }

    final waitDuration = nextWakeup.difference(now);
    if (waitDuration <= Duration.zero) {
      continue;
    }

    if (returnedToApp || returnSignal == null) {
      await _waitForDurationOrCancellation(
        waitDuration,
        cancellationController,
        cancelMessage,
      );
      continue;
    }

    await Future.any<void>([
      _waitForDurationOrCancellation(
        waitDuration,
        cancellationController,
        cancelMessage,
      ),
      returnSignal,
    ]);
  }
}

Future<bool> waitForPackageUninstalled({
  required String packageName,
  required Duration timeout,
  InstallCancellationController? cancellationController,
  Future<bool> Function(String packageName) isAppInstalledFn =
      DeviceApps.isAppInstalled,
}) async {
  const cancelMessage = '재설치를 취소했습니다.';
  final endAt = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(endAt)) {
    _throwIfCancelled(cancellationController, cancelMessage);
    final installed = await isAppInstalledFn(packageName);
    _throwIfCancelled(cancellationController, cancelMessage);
    if (!installed) {
      return true;
    }
    await _waitForDurationOrCancellation(
      const Duration(seconds: 2),
      cancellationController,
      cancelMessage,
    );
  }
  return false;
}

Future<String> _downloadArtifact({
  required String artifactUrl,
  required String packageName,
  required void Function(InstallProgress progress) onProgress,
  InstallCancellationController? cancellationController,
}) async {
  final dir = await getExternalStorageDirectory();
  if (dir == null) {
    throw Exception('외부 저장소 접근 실패');
  }

  final fileName = '$packageName-${DateTime.now().millisecondsSinceEpoch}.apk';
  final path = p.join(dir.path, fileName);
  final file = File(path);

  onProgress(
    InstallProgress(
      phase: InstallPhase.downloading,
      message: '패키지 다운로드 중...',
      fraction: 0,
    ),
  );

  _throwIfCancelled(cancellationController, '다운로드를 취소했습니다.');
  final dio = Dio();
  try {
    await dio.download(
      artifactUrl,
      path,
      cancelToken: cancellationController?.downloadCancelToken,
      onReceiveProgress: (received, total) {
        final progress = total > 0 ? received / total : null;
        onProgress(
          InstallProgress(
            phase: InstallPhase.downloading,
            message: '패키지 다운로드 중...',
            fraction: progress,
          ),
        );
      },
    );
    _throwIfCancelled(cancellationController, '다운로드를 취소했습니다.');
  } on DioException catch (e) {
    if (e.type != DioExceptionType.cancel) {
      rethrow;
    }
    if (await file.exists()) {
      try {
        await file.delete();
      } catch (_) {
        // Ignore cleanup failures for a cancelled partial download.
      }
    }
    throw const InstallCancelledException('다운로드를 취소했습니다.');
  }

  return path;
}

Future<bool> _openInstaller(String path) async {
  final result = await OpenFilex.open(path);
  return result.type == ResultType.done;
}

void _throwIfCancelled(
  InstallCancellationController? cancellationController,
  String message,
) {
  if (cancellationController?.isCancelled ?? false) {
    throw InstallCancelledException(message);
  }
}

Future<void> _waitForDurationOrCancellation(
  Duration duration,
  InstallCancellationController? cancellationController,
  String cancelMessage,
) async {
  if (duration <= Duration.zero) {
    _throwIfCancelled(cancellationController, cancelMessage);
    return;
  }

  if (cancellationController == null) {
    await Future<void>.delayed(duration);
    return;
  }

  await Future.any<void>([
    Future<void>.delayed(duration),
    cancellationController.whenCancelled.then((_) {
      throw InstallCancelledException(cancelMessage);
    }),
  ]);
}
