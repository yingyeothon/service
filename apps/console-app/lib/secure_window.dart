import 'dart:async';

import 'package:flutter/services.dart';

/// How long a copied credential may stay on the clipboard.
const sensitiveClipboardTtl = Duration(seconds: 60);

/// Screen and clipboard protection for a one-time credential.
///
/// `setSecure(true)` sets `FLAG_SECURE` on the (single) activity, which blanks
/// screenshots, screen recording and the recents thumbnail for the whole app
/// — so every `true` must be paired with a `false`. `copySensitive` marks the
/// clip as sensitive so the Android 13+ clipboard preview does not echo it,
/// and clears it after [clearAfter] if it is still the clip this call wrote.
abstract class SecureWindow {
  Future<void> setSecure(bool secure);
  Future<void> copySensitive(
    String text, {
    Duration clearAfter = sensitiveClipboardTtl,
  });
}

/// `life.yyt.console/window` (android/…/MainActivity.kt). Platforms without
/// the channel (tests, iOS today) fall back to a plain clipboard write and a
/// Dart timer.
class PlatformSecureWindow implements SecureWindow {
  const PlatformSecureWindow();

  static const _channel = MethodChannel('life.yyt.console/window');

  @override
  Future<void> setSecure(bool secure) async {
    try {
      await _channel.invokeMethod<void>('setSecure', {'secure': secure});
    } on MissingPluginException {
      // No native side: nothing to protect with.
    }
  }

  /// The timed clear runs natively: from Android 10 a backgrounded app
  /// cannot read the clipboard, so a Dart timer comparing its text would
  /// never clear it once the user switched to the app they paste into.
  @override
  Future<void> copySensitive(
    String text, {
    Duration clearAfter = sensitiveClipboardTtl,
  }) async {
    try {
      await _channel.invokeMethod<void>('copySensitive', {
        'text': text,
        'clearAfterMs': clearAfter.inMilliseconds,
      });
    } on MissingPluginException {
      await Clipboard.setData(ClipboardData(text: text));
      scheduleClipboardClear(text, after: clearAfter);
    }
  }
}

/// Clears the clipboard after [after] if it still holds [text]: the fallback
/// for a platform without the native channel. Deliberately not tied to a
/// widget: leaving the screen must not leave the value behind.
Timer scheduleClipboardClear(
  String text, {
  Duration after = sensitiveClipboardTtl,
}) => Timer(after, () async {
  try {
    final current = await Clipboard.getData(Clipboard.kTextPlain);
    if (current?.text == text) {
      await Clipboard.setData(const ClipboardData(text: ''));
    }
  } catch (_) {
    // A clipboard the app cannot read is one it did not write last.
  }
});
