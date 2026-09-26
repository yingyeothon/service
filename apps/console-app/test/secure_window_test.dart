import 'package:yyt_console/secure_window.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'projects/widget_test_support.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('life.yyt.console/window');
  final platform = TestPlatform();
  setUp(platform.install);
  tearDown(platform.uninstall);

  TestDefaultBinaryMessenger messenger() =>
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

  /// A platform without the native side (iOS today): the channel answers
  /// `MissingPluginException`, inside the test's fake clock.
  void noNativeSide() {
    messenger().setMockMethodCallHandler(
      channel,
      (_) async => throw MissingPluginException(),
    );
    addTearDown(() => messenger().setMockMethodCallHandler(channel, null));
  }

  testWidgets('copySensitive hands the timed clear to the native side', (
    tester,
  ) async {
    final calls = <MethodCall>[];
    messenger().setMockMethodCallHandler(channel, (call) async {
      calls.add(call);
      return null;
    });
    addTearDown(() => messenger().setMockMethodCallHandler(channel, null));
    await const PlatformSecureWindow().copySensitive(
      'value',
      clearAfter: const Duration(seconds: 30),
    );
    expect(calls, hasLength(1));
    expect(calls.single.method, 'copySensitive');
    expect(calls.single.arguments, {'text': 'value', 'clearAfterMs': 30000});
    // The native side owns the clipboard: no Dart write, no Dart timer.
    expect(platform.clipboard, '');
    await tester.pump(const Duration(seconds: 31));
    expect(calls, hasLength(1));
  });

  testWidgets('without the channel it writes the clip and clears it later', (
    tester,
  ) async {
    noNativeSide();
    await const PlatformSecureWindow().copySensitive('value');
    expect(platform.clipboard, 'value');
    await tester.pump(const Duration(seconds: 59));
    expect(platform.clipboard, 'value');
    await tester.pump(const Duration(seconds: 2));
    expect(platform.clipboard, '');
  });

  testWidgets('the fallback leaves a clip someone else wrote since', (
    tester,
  ) async {
    noNativeSide();
    await const PlatformSecureWindow().copySensitive('value');
    platform.clipboard = 'something else';
    await tester.pump(const Duration(seconds: 61));
    expect(platform.clipboard, 'something else');
  });
}
