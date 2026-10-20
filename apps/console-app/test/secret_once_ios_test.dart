import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:yyt_console/projects/channel_models.dart';
import 'package:yyt_console/projects/secret_once_screen.dart';
import 'package:yyt_console/secure_window.dart';

import 'projects/widget_test_support.dart';

void main() {
  final platform = TestPlatform();
  setUp(platform.install);
  tearDown(platform.uninstall);

  Future<FakeSecureWindow> copy(WidgetTester tester) async {
    final window = FakeSecureWindow();
    await tester.pumpWidget(
      MaterialApp(
        home: SecretOnceScreen(
          created: CreatedChannel(
            channel: Channel.fromJson({
              'id': 'ch_1',
              'kind': 'auth',
              'name': 'login',
              'createdAt': 1,
            }),
            credential: 'sentinel-secret',
          ),
          detailBuilder: (_) => const SizedBox(),
          secureWindow: window,
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('채널 시크릿 복사'));
    await tester.pump();
    return window;
  }

  testWidgets('iOS says and passes the pasteboard expiry of two minutes', (
    tester,
  ) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    final window = await copy(tester);
    expect(window.calls.last, 'copySensitive:120s');
    expect(find.text('복사했습니다. 클립보드는 2분 뒤에 비웁니다.'), findsOneWidget);
    // Let the fallback clear timer run out before the test ends.
    await tester.pump(const Duration(minutes: 3));
    debugDefaultTargetPlatformOverride = null;
  });

  testWidgets('Android keeps 60 seconds', (tester) async {
    final window = await copy(tester);
    expect(window.calls.last, 'copySensitive:60s');
    expect(find.text('복사했습니다. 클립보드는 60초 뒤에 비웁니다.'), findsOneWidget);
    await tester.pump(const Duration(minutes: 2));
  });

  test('platformClipboardTtl follows the device', () {
    addTearDown(() => debugDefaultTargetPlatformOverride = null);
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    expect(platformClipboardTtl(), iosSensitiveClipboardTtl);
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    expect(platformClipboardTtl(), sensitiveClipboardTtl);
  });
}
