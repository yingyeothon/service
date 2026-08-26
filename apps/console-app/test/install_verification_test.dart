import 'dart:async';

import 'package:yyt_console/download_install_launch.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('waitForInstalledVersion', () {
    test(
      'reports installer return without the new version after the grace',
      () async {
        final installerReturned = Completer<void>()..complete();
        final stopwatch = Stopwatch()..start();

        final result = await waitForInstalledVersion(
          packageName: 'com.example.app',
          targetVersion: '2.0.0',
          timeout: const Duration(seconds: 5),
          returnGrace: const Duration(milliseconds: 120),
          pollInterval: const Duration(milliseconds: 30),
          installerReturned: installerReturned.future,
          findInstalledVersionFn: (_) async => null,
          onProgress: (_) {},
        );

        // The grace, not the full verify timeout, bounds the wait.
        expect(stopwatch.elapsed, lessThan(const Duration(seconds: 2)));
        expect(result.cancelledByUser, isFalse);
        expect(result.installerReturnedWithoutInstall, isTrue);
        expect(result.installedVersion, isNull);
      },
    );

    test('gives up when the installer never returns', () async {
      final installerReturned = Completer<void>();

      final result = await waitForInstalledVersion(
        packageName: 'com.example.app',
        targetVersion: '2.0.0',
        timeout: const Duration(seconds: 5),
        maxWaitForReturn: const Duration(milliseconds: 100),
        pollInterval: const Duration(milliseconds: 30),
        installerReturned: installerReturned.future,
        findInstalledVersionFn: (_) async => null,
        onProgress: (_) {},
      );

      expect(result.installerReturnedWithoutInstall, isFalse);
      expect(result.installedVersion, isNull);
    });

    test(
      'does not mark cancellation when installed within grace period',
      () async {
        final installerReturned = Completer<void>()..complete();
        var callCount = 0;

        final result = await waitForInstalledVersion(
          packageName: 'com.example.app',
          targetVersion: '2.0.0',
          timeout: const Duration(milliseconds: 300),
          pollInterval: const Duration(milliseconds: 30),
          installerReturned: installerReturned.future,
          findInstalledVersionFn: (_) async {
            callCount += 1;
            if (callCount >= 2) {
              return '2.0.0';
            }
            return null;
          },
          onProgress: (_) {},
        );

        expect(result.cancelledByUser, isFalse);
        expect(result.installedVersion, '2.0.0');
      },
    );

    test(
      'accepts equivalent installed version when only build suffix differs',
      () async {
        final result = await waitForInstalledVersion(
          packageName: 'com.example.app',
          targetVersion: '1.0.2',
          timeout: const Duration(milliseconds: 90),
          pollInterval: const Duration(milliseconds: 30),
          findInstalledVersionFn: (_) async => '1.0.2+4',
          onProgress: (_) {},
        );

        expect(result.cancelledByUser, isFalse);
        expect(result.installedVersion, '1.0.2+4');
      },
    );

    test(
      'waits for installer return before accepting preinstalled same version',
      () async {
        final installerReturned = Completer<void>();
        var callCount = 0;

        final future = waitForInstalledVersion(
          packageName: 'com.example.app',
          targetVersion: '1.0.2',
          timeout: const Duration(milliseconds: 80),
          pollInterval: const Duration(milliseconds: 20),
          installerReturned: installerReturned.future,
          waitForInstallerReturnBeforeAcceptingVersion: true,
          findInstalledVersionFn: (_) async {
            callCount += 1;
            return '1.0.2+4';
          },
          onProgress: (_) {},
        );

        await Future<void>.delayed(const Duration(milliseconds: 70));
        expect(callCount, greaterThan(1));
        installerReturned.complete();

        final result = await future;

        expect(result.cancelledByUser, isFalse);
        expect(result.installedVersion, '1.0.2+4');
      },
    );

    test(
      'times out normally when no installer return signal is provided',
      () async {
        final result = await waitForInstalledVersion(
          packageName: 'com.example.app',
          targetVersion: '2.0.0',
          timeout: const Duration(milliseconds: 90),
          pollInterval: const Duration(milliseconds: 30),
          findInstalledVersionFn: (_) async => null,
          onProgress: (_) {},
        );

        expect(result.cancelledByUser, isFalse);
        expect(result.installedVersion, isNull);
      },
    );

    test(
      'does not spend verification timeout while installer screen is open',
      () async {
        final installerReturned = Completer<void>();
        var callCount = 0;

        final future = waitForInstalledVersion(
          packageName: 'com.example.app',
          targetVersion: '2.0.0',
          timeout: const Duration(milliseconds: 80),
          pollInterval: const Duration(milliseconds: 20),
          installerReturned: installerReturned.future,
          findInstalledVersionFn: (_) async {
            callCount += 1;
            if (installerReturned.isCompleted && callCount >= 4) {
              return '2.0.0';
            }
            return null;
          },
          onProgress: (_) {},
        );

        await Future<void>.delayed(const Duration(milliseconds: 140));
        installerReturned.complete();

        final result = await future;

        expect(result.cancelledByUser, isFalse);
        expect(result.installedVersion, '2.0.0');
      },
    );

    test('stops immediately when the user cancels waiting', () async {
      final controller = InstallCancellationController();

      final future = waitForInstalledVersion(
        packageName: 'com.example.app',
        targetVersion: '2.0.0',
        timeout: const Duration(seconds: 5),
        pollInterval: const Duration(seconds: 2),
        cancellationController: controller,
        findInstalledVersionFn: (_) async => null,
        onProgress: (_) {},
      );

      controller.cancel();

      await expectLater(future, throwsA(isA<InstallCancelledException>()));
    });
  });

  group('waitForPackageUninstalled', () {
    test('stops immediately when the user cancels uninstall waiting', () async {
      final controller = InstallCancellationController();

      final future = waitForPackageUninstalled(
        packageName: 'com.example.app',
        timeout: const Duration(seconds: 5),
        cancellationController: controller,
        isAppInstalledFn: (_) async => true,
      );

      controller.cancel();

      await expectLater(future, throwsA(isA<InstallCancelledException>()));
    });
  });
}
