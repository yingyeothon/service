import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:yyt_console/push/apns_token.dart';
import 'package:yyt_console/push/push_config.dart';

void main() {
  const both = PushConfig(
    projectId: 'p',
    senderId: '1',
    appId: '1:1:android:a',
    apiKey: 'ka',
    iosAppId: '1:1:ios:i',
    iosApiKey: 'ki',
  );

  group('PushConfig.forPlatform', () {
    test('picks each platform its own app id and API key', () {
      final android = both.forPlatform(TargetPlatform.android)!;
      expect([android.appId, android.apiKey], ['1:1:android:a', 'ka']);
      final ios = both.forPlatform(TargetPlatform.iOS)!;
      expect([ios.appId, ios.apiKey], ['1:1:ios:i', 'ki']);
      expect([ios.projectId, ios.senderId], ['p', '1']);
      expect(ios.isComplete, isTrue);
    });

    test('an Android-only config leaves push off on iOS', () {
      const android = PushConfig(
        projectId: 'p',
        senderId: '1',
        appId: '1:1:android:a',
        apiKey: 'ka',
      );
      expect(android.forPlatform(TargetPlatform.android)!.isComplete, isTrue);
      expect(android.forPlatform(TargetPlatform.iOS)!.isComplete, isFalse);
    });

    test('other platforms have no Firebase app', () {
      for (final p in [
        TargetPlatform.macOS,
        TargetPlatform.linux,
        TargetPlatform.windows,
        TargetPlatform.fuchsia,
      ]) {
        expect(both.forPlatform(p), isNull);
      }
    });
  });

  group('waitForApnsToken', () {
    test('returns at once when the token is there', () async {
      final delays = <Duration>[];
      expect(
        await waitForApnsToken(
          () async => 'apns',
          delay: (d) async => delays.add(d),
        ),
        isTrue,
      );
      expect(delays, isEmpty);
    });

    test('polls one second apart until the token arrives', () async {
      var reads = 0;
      final delays = <Duration>[];
      expect(
        await waitForApnsToken(
          () async => ++reads < 4 ? null : 'apns',
          delay: (d) async => delays.add(d),
        ),
        isTrue,
      );
      expect(reads, 4);
      expect(delays, List.filled(3, const Duration(seconds: 1)));
    });

    test('gives up after ten reads; a throwing read counts as none', () async {
      var reads = 0;
      expect(
        await waitForApnsToken(() async {
          reads++;
          if (reads.isEven) throw StateError('not ready');
          return null;
        }, delay: (_) async {}),
        isFalse,
      );
      expect(reads, 10);
    });
  });

  group('ApnsGate', () {
    test('concurrent operations share one wait, and a token once seen is '
        'not read again', () async {
      var reads = 0;
      final gate = ApnsGate(
        () async => ++reads < 3 ? null : 'apns',
        delay: (_) async {},
      );
      expect(await Future.wait([gate.ready(), gate.ready(), gate.ready()]), [
        true,
        true,
        true,
      ]);
      expect(reads, 3);
      expect(await gate.ready(), isTrue);
      expect(reads, 3);
    });

    test('a miss is forgotten: the next operation waits again', () async {
      var reads = 0;
      String? token;
      final gate = ApnsGate(() async {
        reads++;
        return token;
      }, delay: (_) async {});
      expect(await gate.ready(), isFalse);
      expect(reads, 10);
      token = 'apns';
      expect(await gate.ready(), isTrue);
      expect(reads, 11);
    });
  });
}
