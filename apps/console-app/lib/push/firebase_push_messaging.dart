import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:yyt_console/auth/auth_diagnostics.dart';
import 'package:yyt_console/push/apns_token.dart';
import 'package:yyt_console/push/push_config.dart';
import 'package:yyt_console/push/push_messaging.dart';

/// Initialises Firebase from [config] and returns the transport, or `null`
/// when this build has no config for this platform (push is off) or Firebase
/// cannot start (no Play services). Never throws: push is an extra, the app
/// works without it. Android and iOS only.
Future<PushMessaging?> connectFirebasePush({
  PushConfig config = PushConfig.fromBuild,
}) async {
  if (kIsWeb) return null;
  final platform = defaultTargetPlatform;
  final own = config.forPlatform(platform);
  if (own == null || !own.isComplete) return null;
  final ios = platform == TargetPlatform.iOS;
  try {
    await Firebase.initializeApp(
      options: FirebaseOptions(
        apiKey: own.apiKey,
        appId: own.appId,
        messagingSenderId: own.senderId,
        projectId: own.projectId,
        iosBundleId: ios ? PushConfig.iosBundleId : null,
      ),
    );
    // iOS keeps its default of showing nothing for a foreground message: as
    // on Android, the app's SnackBar (`onForeground`) is the notice, and it
    // passes `PushService.accept` first.
    return FirebasePushMessaging(FirebaseMessaging.instance, ios: ios);
  } catch (e, st) {
    // The error may quote the options; the logger records its type only.
    AuthDiagnosticLogger.logUiFailure(
      scope: 'push_connect',
      error: StateError('firebase init failed: ${e.runtimeType}'),
      stackTrace: st,
    );
    return null;
  }
}

class FirebasePushMessaging implements PushMessaging {
  FirebasePushMessaging(this._messaging, {bool ios = false})
    : _apns = ios ? ApnsGate(_messaging.getAPNSToken) : null;

  final FirebaseMessaging _messaging;

  /// On iOS a topic operation needs the APNs token first; one wait serves
  /// every operation of a sync.
  final ApnsGate? _apns;

  Future<void> _apnsReady() async {
    final apns = _apns;
    if (apns == null) return;
    if (!await apns.ready()) throw StateError('apns-token-not-set');
  }

  static PushEvent _event(RemoteMessage m) => PushEvent(
    from: m.from,
    data: m.data,
    title: m.notification?.title,
    body: m.notification?.body,
  );

  @override
  Future<void> subscribe(String topic) async {
    await _apnsReady();
    await _messaging.subscribeToTopic(topic);
  }

  @override
  Future<void> unsubscribe(String topic) async {
    await _apnsReady();
    await _messaging.unsubscribeFromTopic(topic);
  }

  @override
  Future<bool> requestPermission() async {
    final s = await _messaging.requestPermission(
      alert: true,
      badge: true,
      sound: true,
    );
    return s.authorizationStatus == AuthorizationStatus.authorized;
  }

  @override
  Stream<PushEvent> get onForeground => FirebaseMessaging.onMessage.map(_event);

  @override
  Stream<PushEvent> get onOpened =>
      FirebaseMessaging.onMessageOpenedApp.map(_event);

  @override
  Stream<void> get onTokenRefresh => _messaging.onTokenRefresh.map((_) {});

  @override
  Future<PushEvent?> initialMessage() async {
    final m = await _messaging.getInitialMessage();
    return m == null ? null : _event(m);
  }
}
