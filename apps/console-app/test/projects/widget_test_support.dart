import 'dart:async';
import 'dart:convert';

import 'package:yyt_console/auth/auth_config.dart';
import 'package:yyt_console/secure_window.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

/// Shared setup for the project widget tests.

http.Response jsonResponse(Object body, [int status = 200]) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

/// `AuthState` reads profiles from secure storage on construction; the
/// clipboard is an in-memory string.
class TestPlatform {
  String clipboard = '';

  void install() {
    AuthConfig.setServerUrl('console-dev.yyt.life');
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(
      const MethodChannel('plugins.it_nomads.com/flutter_secure_storage'),
      (call) async => call.method == 'readAll' ? <String, String>{} : null,
    );
    messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      switch (call.method) {
        case 'Clipboard.setData':
          clipboard = (call.arguments as Map)['text'] as String? ?? '';
          return null;
        case 'Clipboard.getData':
          return {'text': clipboard};
      }
      return null;
    });
  }

  void uninstall() {
    AuthConfig.clearServerUrl();
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(SystemChannels.platform, null);
  }
}

/// Records every call instead of touching a real window. [hold], when set,
/// keeps `setSecure(true)` pending until it completes. `copySensitive`
/// stands in for the native side: it writes the clip and clears it after
/// `clearAfter` if it is still the one written (MainActivity.kt compares the
/// clip's label; here the text).
class FakeSecureWindow implements SecureWindow {
  final calls = <String>[];
  Completer<void>? hold;

  @override
  Future<void> setSecure(bool secure) async {
    calls.add('setSecure:$secure');
    if (secure && hold != null) await hold!.future;
  }

  @override
  Future<void> copySensitive(
    String text, {
    Duration clearAfter = sensitiveClipboardTtl,
  }) async {
    calls.add('copySensitive:${clearAfter.inSeconds}s');
    await Clipboard.setData(ClipboardData(text: text));
    scheduleClipboardClear(text, after: clearAfter);
  }
}
