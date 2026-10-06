import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:yyt_console/auth/auth_diagnostics.dart';
import 'package:yyt_console/push/push_config.dart';
import 'package:yyt_console/push/push_messaging.dart';

/// Initialises Firebase from [config] and returns the transport, or `null`
/// when this build has no config (push is off) or Firebase cannot start (no
/// Play services). Never throws: push is an extra, the app works without it.
Future<PushMessaging?> connectFirebasePush({
  PushConfig config = PushConfig.fromBuild,
}) async {
  if (!config.isComplete) return null;
  if (kIsWeb || defaultTargetPlatform != TargetPlatform.android) return null;
  try {
    await Firebase.initializeApp(
      options: FirebaseOptions(
        apiKey: config.apiKey,
        appId: config.appId,
        messagingSenderId: config.senderId,
        projectId: config.projectId,
      ),
    );
    return FirebasePushMessaging(FirebaseMessaging.instance);
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
  FirebasePushMessaging(this._messaging);

  final FirebaseMessaging _messaging;

  static PushEvent _event(RemoteMessage m) => PushEvent(
    from: m.from,
    data: m.data,
    title: m.notification?.title,
    body: m.notification?.body,
  );

  @override
  Future<void> subscribe(String topic) => _messaging.subscribeToTopic(topic);

  @override
  Future<void> unsubscribe(String topic) =>
      _messaging.unsubscribeFromTopic(topic);

  @override
  Future<bool> requestPermission() async {
    final s = await _messaging.requestPermission();
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
