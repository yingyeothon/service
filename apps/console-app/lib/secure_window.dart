import 'dart:async';

import 'package:flutter/services.dart';
import 'package:yyt_console/catalog_platform.dart';

/// How long a copied credential may stay on the clipboard.
const sensitiveClipboardTtl = Duration(seconds: 60);

/// The iOS pasteboard expiry, fixed in ios/Runner/AppDelegate.swift
/// (docs/decisions.md *Console app and push on iOS* #6).
const iosSensitiveClipboardTtl = Duration(minutes: 2);

/// The clipboard lifetime this device actually applies.
Duration platformClipboardTtl() =>
    isIosDevice() ? iosSensitiveClipboardTtl : sensitiveClipboardTtl;

/// [ttl] as the copy notice says it: whole minutes from two up, else seconds.
String clipboardTtlText(Duration ttl) =>
    ttl.inMinutes >= 2 && ttl.inSeconds % 60 == 0
    ? '${ttl.inMinutes}분'
    : '${ttl.inSeconds}초';

/// Screen and clipboard protection for a one-time credential.
///
/// `setSecure(true)` sets `FLAG_SECURE` on the (single) Android activity,
/// which blanks screenshots, screen recording and the recents thumbnail for
/// the whole app; on iOS, which cannot block screenshots, it covers the
/// window while the app is inactive so the app switcher snapshot shows
/// nothing. Every `true` must be paired with a `false`. `copySensitive`
/// marks the clip as sensitive so the Android 13+ clipboard preview does not
/// echo it and clears it after [clearAfter] if it is still the clip this call
/// wrote; on iOS the item is local-only (no Universal Clipboard) and expires
/// after [iosSensitiveClipboardTtl] whatever [clearAfter] says.
abstract class SecureWindow {
  Future<void> setSecure(bool secure);
  Future<void> copySensitive(
    String text, {
    Duration clearAfter = sensitiveClipboardTtl,
  });
}

/// `life.yyt.console/window` (android/…/MainActivity.kt,
/// ios/Runner/AppDelegate.swift). Platforms without the channel (tests) fall
/// back to a plain clipboard write and a Dart timer.
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
  /// never clear it once the user switched to the app they paste into; iOS
  /// suspends a backgrounded app, so the pasteboard expires the item itself
  /// (fixed two minutes there, docs/decisions.md iOS #6).
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
