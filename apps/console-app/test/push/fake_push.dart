import 'dart:async';

import 'package:yyt_console/push/push_messaging.dart';
import 'package:yyt_console/push/push_service.dart';

/// An in-memory transport: records every call, fails the topics in [failing]
/// and hangs on the ones in [hanging].
class FakeMessaging implements PushMessaging {
  final calls = <String>[];
  final topics = <String>{};
  final failing = <String>{};
  final hanging = <String>{};
  int permissionRequests = 0;
  bool grant = true;

  /// The prompt stays open until this completes.
  Completer<void>? permissionHold;
  bool permissionFails = false;
  PushEvent? initial;
  final foreground = StreamController<PushEvent>.broadcast();
  final opened = StreamController<PushEvent>.broadcast();
  final tokenRefresh = StreamController<void>.broadcast();

  Future<void> _op(String name, String topic, void Function() apply) {
    calls.add('$name $topic');
    if (hanging.contains(topic)) return Completer<void>().future;
    if (failing.contains(topic)) return Future.error(StateError('offline'));
    apply();
    return Future.value();
  }

  @override
  Future<void> subscribe(String topic) =>
      _op('sub', topic, () => topics.add(topic));

  @override
  Future<void> unsubscribe(String topic) =>
      _op('unsub', topic, () => topics.remove(topic));

  @override
  Future<bool> requestPermission() async {
    permissionRequests += 1;
    await permissionHold?.future;
    if (permissionFails) throw StateError('no activity');
    return grant;
  }

  @override
  Stream<PushEvent> get onForeground => foreground.stream;

  @override
  Stream<PushEvent> get onOpened => opened.stream;

  @override
  Stream<void> get onTokenRefresh => tokenRefresh.stream;

  @override
  Future<PushEvent?> initialMessage() async => initial;
}

class MemoryPushStore implements PushStore {
  final values = <String, String>{};
  int writes = 0;

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async {
    writes += 1;
    values[key] = value;
  }
}

/// A catalog notice as FCM delivers it for [topic].
PushEvent catalogEvent(
  String topic,
  String appId, {
  String version = '1.2.3',
  String kind = 'catalog',
  String? title = '앱 업데이트',
  String? builds,
}) => PushEvent(
  from: '/topics/$topic',
  data: {
    'kind': kind,
    'appId': appId,
    'version': version,
    'platform': 'android',
    'builds': ?builds,
  },
  title: title,
  body: '새 버전 $version',
);
