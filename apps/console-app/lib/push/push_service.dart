import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:yyt_console/push/push_messaging.dart';

/// Where the service keeps what it subscribed to between launches.
abstract class PushStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
}

class SecurePushStore implements PushStore {
  const SecurePushStore();

  static const FlutterSecureStorage _storage = FlutterSecureStorage();

  @override
  Future<String?> read(String key) => _storage.read(key: key);

  @override
  Future<void> write(String key, String value) =>
      _storage.write(key: key, value: value);
}

/// A catalog update notice (`data.kind == "catalog"`) the app accepted.
@immutable
class CatalogPush {
  const CatalogPush({
    required this.appId,
    required this.version,
    this.builds = '',
    this.title,
    this.body,
  });

  final String appId;

  /// The announced version; empty when the artifact carried none. For a
  /// burst of several versions, the newest.
  final String version;

  /// The server's summary of the burst, such as
  /// `Android release · AAB / iOS App Store`, with one `1.0.1: …` line per
  /// version when there are several; empty from a server that predates
  /// bursts.
  final String builds;
  final String? title;
  final String? body;
}

/// What the open app says for [p] about the app called [name]: the version
/// and, from a server that sends it, the burst's builds. A burst of several
/// versions lists one line per version under the name.
String foregroundNoticeText(String name, CatalogPush p) {
  final builds = p.builds;
  if (builds.contains('\n')) return '$name 업데이트\n$builds';
  final head = p.version.isEmpty ? '$name 새 빌드' : '$name 새 버전 ${p.version}';
  if (builds.isNotEmpty) return '$head\n$builds';
  return p.version.isEmpty ? '$name 새 빌드가 올라왔습니다.' : head;
}

typedef PushConnect = Future<PushMessaging?> Function();
typedef PushErrorSink =
    void Function(String scope, Object error, StackTrace stackTrace);

/// The only topic names the app follows: the server's catalog topics
/// (`yyt.catalog.{stage}.{appId}`). Anything else a server names is ignored.
final RegExp catalogTopicPattern = RegExp(
  r'^yyt\.catalog\.[a-z0-9-]+\.[A-Za-z0-9_-]+$',
);

/// Everything the app does with push (docs/push.md *Console app*): one FCM
/// topic per catalog app **installed on this device**, named by the server,
/// and the routing of what arrives on them.
///
/// - A *scope* is the signed-in profile. Topics belong to the scope that
///   listed them; signing out or switching profile unsubscribes all of them.
/// - A *source* is one list of the app (`apps`, `browse`). Each reports the
///   installed apps it sees; what is subscribed is their union, so a tab
///   that has not loaded yet keeps what it reported last time.
/// - The subscribed set is persisted, so a sync sends the difference only.
/// - A topic is *pending* from the moment an operation on it is issued until
///   the transport confirms one: the FCM SDK keeps a failed or timed-out
///   request queued and may complete it later, so only a confirmed
///   unsubscribe forgets a topic. Pending topics are persisted too.
/// - The confirmed set is distrusted on a token refresh and every
///   [healEvery]: the desired topics are subscribed again (a no-op when they
///   still are), so a restored or reset installation converges.
/// - A message is accepted only for an app the current scope subscribed to;
///   anything else — another kind, another profile's or stage's topic — is
///   dropped.
///
/// Without a transport ([connect] answers `null`: a build without the
/// Firebase defines) every method is a no-op and nothing is stored.
class PushService {
  PushService({
    this._connect,
    this._store = const SecurePushStore(),
    this.opTimeout = const Duration(seconds: 15),
    this.healEvery = const Duration(days: 7),
    this._onError,
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now;

  static const stateKey = 'push_topics';
  static const askedKey = 'push_permission_asked';

  final PushConnect? _connect;
  final PushStore _store;
  final PushErrorSink? _onError;
  final DateTime Function() _now;

  /// How often the confirmed set is subscribed again without a reason.
  final Duration healEvery;

  /// How long one (un)subscribe may take before it is left for the next sync.
  final Duration opTimeout;

  PushMessaging? _messaging;
  bool _started = false;
  bool _disposed = false;
  Future<void> _tail = Future<void>.value();
  final _subscriptions = <StreamSubscription<Object?>>[];
  final _foreground = StreamController<CatalogPush>.broadcast();

  String? _scope;

  /// source → topic → app id, of the current scope.
  Map<String, Map<String, String>> _sources = {};

  /// topic → app id, as last confirmed by the transport.
  Map<String, String> _subscribed = {};

  /// Topics with an operation issued and no confirmation since: possibly
  /// subscribed. Left only by a confirmed unsubscribe, or — into
  /// [_subscribed] — by a confirmed subscribe.
  Set<String> _pending = {};

  /// When [_subscribed] was last distrusted (ms since the epoch).
  int _healedAt = 0;
  String? _saved;

  /// Persisted: the prompt returned once. [_askedThisRun] also covers a
  /// prompt that failed, so one launch never asks twice.
  bool _asked = false;
  bool _askedThisRun = false;

  /// A tapped notification nobody has opened yet. It waits here because a
  /// tap can start the app, long before a screen exists to show it.
  final ValueNotifier<CatalogPush?> pendingOpen = ValueNotifier(null);

  /// Update notices received while the app is in the foreground.
  Stream<CatalogPush> get foreground => _foreground.stream;

  /// Whether a transport is connected (false until [start] has finished).
  bool get enabled => _messaging != null;

  /// The topics currently subscribed, for tests and diagnostics.
  Set<String> get subscribedTopics => _subscribed.keys.toSet();

  /// Topics that may be subscribed without a confirmation either way.
  Set<String> get pendingTopics => {..._pending};

  /// Whether [source] reported an installed app for [scope] the last time it
  /// loaded — in this launch or an earlier one.
  Future<bool> follows({required String scope, required String source}) {
    var answer = false;
    return _run(() async {
      answer =
          _messaging != null &&
          scope == _scope &&
          (_sources[source]?.isNotEmpty ?? false);
    }).then((_) => answer);
  }

  /// Connects, restores the persisted state, retries what a previous run
  /// left undone and starts routing. Safe to call once; never throws.
  Future<void> start() => _run(() async {
    if (_started) return;
    _started = true;
    final PushMessaging? m;
    try {
      m = await _connect?.call();
    } catch (e, st) {
      _onError?.call('push_connect', e, st);
      return;
    }
    if (m == null || _disposed) return;
    _messaging = m;
    await _load();
    _subscriptions
      ..add(m.onForeground.listen(_onForegroundEvent))
      ..add(m.onOpened.listen(_onOpenedEvent))
      // A new token is a new installation as far as FCM's topics go.
      ..add(
        m.onTokenRefresh.listen(
          (_) => _run(() => _reconcile(heal: true)).ignore(),
        ),
      );
    try {
      final initial = await m.initialMessage();
      if (initial != null) _onOpenedEvent(initial);
    } catch (e, st) {
      _onError?.call('push_initial', e, st);
    }
    await _reconcile();
  });

  /// The signed-in profile, or `null` when signed out. A change drops every
  /// topic of the previous scope and any tap that belonged to it.
  Future<void> setScope(String? scope) => _run(() async {
    if (_messaging == null || scope == _scope) return;
    _scope = scope;
    _sources = {};
    pendingOpen.value = null;
    await _reconcile();
  });

  /// One list's view of the installed apps: [topics] maps the server-given
  /// topic to its app id. Subscribes what is new, unsubscribes what no source
  /// reports any more. A report for another scope (a load that outlived its
  /// profile) is ignored, and so is a name that is not a catalog topic
  /// ([catalogTopicPattern]). The first sync that has something to subscribe
  /// to asks for the notification permission, once per install.
  Future<void> sync({
    required String scope,
    required String source,
    required Map<String, String> topics,
  }) => _run(() async {
    final m = _messaging;
    if (m == null || scope != _scope) return;
    _sources = {
      ..._sources,
      source: {
        for (final e in topics.entries)
          if (catalogTopicPattern.hasMatch(e.key)) e.key: e.value,
      },
    };
    await _reconcile();
    if (_asked || _askedThisRun || _desired().isEmpty) return;
    _askedThisRun = true;
    try {
      await m.requestPermission();
    } catch (e, st) {
      _onError?.call('push_permission', e, st);
      return;
    }
    // Recorded once the prompt returned, whatever the answer: a decline is
    // not asked again, a prompt that never came back (the app was killed
    // under it) or failed is asked on a later launch.
    _asked = true;
    await _write(askedKey, '1');
  });

  /// Hands over the pending tap, if any, and forgets it.
  CatalogPush? takePendingOpen() {
    final p = pendingOpen.value;
    pendingOpen.value = null;
    return p;
  }

  /// Resolves once everything queued so far has run.
  Future<void> get idle => _tail;

  void dispose() {
    _disposed = true;
    for (final s in _subscriptions) {
      s.cancel();
    }
    _foreground.close();
    pendingOpen.dispose();
  }

  // ---- routing -------------------------------------------------------------

  /// The notice in [e], or `null` when it is not one this profile asked for.
  @visibleForTesting
  CatalogPush? accept(PushEvent e) {
    if (_scope == null) return null;
    if (e.data['kind'] != 'catalog') return null;
    final appId = e.data['appId'];
    if (appId is! String || appId.isEmpty) return null;
    final desired = _desired();
    final from = e.from;
    if (from != null && from.startsWith('/topics/')) {
      // The topic carries the stage: only the one this profile's server
      // named for this app counts.
      if (desired[from.substring('/topics/'.length)] != appId) return null;
    } else if (!desired.containsValue(appId)) {
      return null;
    }
    final version = e.data['version'];
    final builds = e.data['builds'];
    return CatalogPush(
      appId: appId,
      version: version is String ? version : '',
      builds: builds is String ? builds.trim() : '',
      title: e.title,
      body: e.body,
    );
  }

  void _onForegroundEvent(PushEvent e) {
    final p = accept(e);
    if (p != null && !_foreground.isClosed) _foreground.add(p);
  }

  void _onOpenedEvent(PushEvent e) {
    final p = accept(e);
    if (p != null && !_disposed) pendingOpen.value = p;
  }

  // ---- subscriptions -------------------------------------------------------

  Map<String, String> _desired() => {
    if (_scope != null)
      for (final s in _sources.values) ...s,
  };

  /// Moves the transport to the desired set: unsubscribes every topic that
  /// is or may be subscribed and is not wanted, subscribes every wanted one
  /// that is not confirmed. Each topic is recorded as pending **before** its
  /// call, so an operation that fails or times out — and that the SDK may
  /// still complete later — is known to the next call, the next launch and
  /// the next sign-out. With [heal], or once per [healEvery], nothing counts
  /// as confirmed.
  Future<void> _reconcile({bool heal = false}) async {
    final m = _messaging;
    if (m == null) return;
    final now = _now().millisecondsSinceEpoch;
    if (heal ||
        now < _healedAt ||
        now - _healedAt >= healEvery.inMilliseconds) {
      _pending.addAll(_subscribed.keys);
      _subscribed = {};
      _healedAt = now;
    }
    final desired = _desired();
    final drop = [
      for (final t in {..._subscribed.keys, ..._pending})
        if (!desired.containsKey(t)) t,
    ];
    final add = [
      for (final t in desired.keys)
        if (!_subscribed.containsKey(t)) t,
    ];
    for (final t in drop) {
      _subscribed.remove(t);
    }
    _pending.addAll(drop);
    _pending.addAll(add);
    await _save();
    if (drop.isEmpty && add.isEmpty) return;

    Future<void> op(
      String scope,
      Future<void> Function() f,
      void Function() ok,
    ) async {
      try {
        await f().timeout(opTimeout);
        ok();
      } catch (e, st) {
        _onError?.call(scope, e, st);
      }
    }

    await Future.wait([
      for (final t in drop)
        op(
          'push_unsubscribe',
          () => m.unsubscribe(t),
          () => _pending.remove(t),
        ),
      for (final t in add)
        op('push_subscribe', () => m.subscribe(t), () {
          _pending.remove(t);
          _subscribed[t] = desired[t]!;
        }),
    ]);
    await _save();
  }

  // ---- persistence ---------------------------------------------------------

  static Map<String, String> _stringMap(Object? v) => {
    if (v is Map)
      for (final e in v.entries)
        if (e.key is String && e.value is String)
          e.key as String: e.value as String,
  };

  Future<void> _load() async {
    try {
      _asked = await _store.read(askedKey) == '1';
      final raw = await _store.read(stateKey);
      if (raw == null || raw.isEmpty) return;
      final j = jsonDecode(raw);
      if (j is! Map) return;
      _scope = j['scope'] is String ? j['scope'] as String : null;
      final sources = j['sources'];
      _sources = {
        if (sources is Map)
          for (final e in sources.entries)
            if (e.key is String) e.key as String: _stringMap(e.value),
      };
      _subscribed = _stringMap(j['subscribed']);
      final pending = j['pending'];
      _pending = {
        if (pending is List)
          for (final t in pending)
            if (t is String) t,
      };
      _healedAt = j['healedAt'] is int ? j['healedAt'] as int : 0;
    } catch (e, st) {
      // Unreadable state reads as "nothing subscribed"; the next sync
      // subscribes again, which the transport treats as a no-op.
      _onError?.call('push_state', e, st);
    }
  }

  Future<void> _save() async {
    final next = jsonEncode({
      'scope': _scope,
      'sources': _sources,
      'subscribed': _subscribed,
      'pending': _pending.toList()..sort(),
      'healedAt': _healedAt,
    });
    if (next == _saved) return;
    if (await _write(stateKey, next)) _saved = next;
  }

  Future<bool> _write(String key, String value) async {
    try {
      await _store.write(key, value);
      return true;
    } catch (e, st) {
      _onError?.call('push_state', e, st);
      return false;
    }
  }

  /// One operation at a time, in call order; a failure never breaks the queue.
  Future<void> _run(Future<void> Function() f) {
    final r = _tail.then((_) => _disposed ? null : f());
    _tail = r.catchError((Object _) {});
    return r;
  }
}
