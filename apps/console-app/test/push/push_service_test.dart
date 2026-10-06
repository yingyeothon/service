import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:yyt_console/push/firebase_push_messaging.dart';
import 'package:yyt_console/push/push_config.dart';
import 'package:yyt_console/push/push_messaging.dart';
import 'package:yyt_console/push/push_service.dart';

import 'fake_push.dart';

const tA = 'yyt.catalog.prod.ca_a';
const tB = 'yyt.catalog.prod.ca_b';
const tC = 'yyt.catalog.prod.ca_c';

void main() {
  late FakeMessaging fcm;
  late MemoryPushStore store;
  final errors = <String>[];
  late DateTime clock;

  PushService service({FakeMessaging? messaging, Duration? opTimeout}) =>
      PushService(
        connect: () async => messaging ?? fcm,
        store: store,
        opTimeout: opTimeout ?? const Duration(seconds: 15),
        onError: (scope, _, _) => errors.add(scope),
        now: () => clock,
      );

  const short = Duration(milliseconds: 20);

  /// A started service signed in as [scope].
  Future<PushService> started({String scope = 'p_1'}) async {
    final s = service();
    await s.start();
    await s.setScope(scope);
    return s;
  }

  setUp(() {
    fcm = FakeMessaging();
    store = MemoryPushStore();
    errors.clear();
    clock = DateTime.utc(2026, 10, 6);
  });

  group('subscriptions', () {
    test('a sync subscribes the installed apps and later sends the '
        'difference only', () async {
      final s = await started();
      await s.sync(
        scope: 'p_1',
        source: 'apps',
        topics: {tA: 'ca_a', tB: 'ca_b'},
      );
      expect(fcm.calls, ['sub $tA', 'sub $tB']);

      // The same list again: nothing to do.
      fcm.calls.clear();
      await s.sync(
        scope: 'p_1',
        source: 'apps',
        topics: {tA: 'ca_a', tB: 'ca_b'},
      );
      expect(fcm.calls, isEmpty);

      // B was uninstalled, C installed.
      await s.sync(
        scope: 'p_1',
        source: 'apps',
        topics: {tA: 'ca_a', tC: 'ca_c'},
      );
      expect(fcm.calls, unorderedEquals(['unsub $tB', 'sub $tC']));
      expect(fcm.topics, {tA, tC});
      expect(s.subscribedTopics, {tA, tC});
    });

    test('the set survives a restart: the next launch resubscribes '
        'nothing', () async {
      final first = await started();
      await first.sync(scope: 'p_1', source: 'apps', topics: {tA: 'ca_a'});
      first.dispose();

      fcm.calls.clear();
      final second = await started();
      expect(second.subscribedTopics, {tA});
      await second.sync(scope: 'p_1', source: 'apps', topics: {tA: 'ca_a'});
      expect(fcm.calls, isEmpty);
    });

    test('sources are a union: a tab that has not loaded keeps what it '
        'reported', () async {
      final s = await started();
      await s.sync(scope: 'p_1', source: 'apps', topics: {tA: 'ca_a'});
      await s.sync(scope: 'p_1', source: 'browse', topics: {tB: 'ca_b'});
      expect(fcm.topics, {tA, tB});

      // A relaunch loads the app tab only; the browse app stays followed.
      s.dispose();
      fcm.calls.clear();
      final next = await started();
      await next.sync(scope: 'p_1', source: 'apps', topics: {tA: 'ca_a'});
      expect(fcm.calls, isEmpty);
      // Until the browse tab reports it gone.
      await next.sync(scope: 'p_1', source: 'browse', topics: {});
      expect(fcm.calls, ['unsub $tB']);
      // An app both lists show stays while either does.
      await next.sync(scope: 'p_1', source: 'browse', topics: {tA: 'ca_a'});
      await next.sync(scope: 'p_1', source: 'apps', topics: {});
      expect(fcm.topics, {tA});
    });

    test('a failed or hanging operation is retried by the next sync, the '
        'rest go through', () async {
      final s = service(opTimeout: const Duration(milliseconds: 20));
      await s.start();
      await s.setScope('p_1');
      fcm.failing.add(tA);
      fcm.hanging.add(tB);
      await s.sync(
        scope: 'p_1',
        source: 'apps',
        topics: {tA: 'ca_a', tB: 'ca_b', tC: 'ca_c'},
      );
      expect(s.subscribedTopics, {tC});
      expect(errors, ['push_subscribe', 'push_subscribe']);

      fcm.failing.clear();
      fcm.hanging.clear();
      fcm.calls.clear();
      await s.sync(
        scope: 'p_1',
        source: 'apps',
        topics: {tA: 'ca_a', tB: 'ca_b', tC: 'ca_c'},
      );
      expect(fcm.calls, unorderedEquals(['sub $tA', 'sub $tB']));
      expect(s.subscribedTopics, {tA, tB, tC});
    });
  });

  group('an unconfirmed operation', () {
    // The FCM SDK keeps a failed or timed-out request queued and may
    // complete it later: the topic must stay known until an unsubscribe is
    // confirmed.
    test('a subscribe that timed out is unsubscribed at sign-out', () async {
      final s = service(opTimeout: short);
      await s.start();
      await s.setScope('p_1');
      fcm.hanging.add(tA);
      await s.sync(scope: 'p_1', source: 'apps', topics: {tA: 'ca_a'});
      expect(s.subscribedTopics, isEmpty);
      expect(s.pendingTopics, {tA});
      // Recorded before the call returned, so a kill here loses nothing.
      expect(
        (jsonDecode(store.values[PushService.stateKey]!) as Map)['pending'],
        [tA],
      );

      fcm.hanging.clear();
      fcm.calls.clear();
      await s.setScope(null);
      expect(fcm.calls, ['unsub $tA']);
      expect(s.pendingTopics, isEmpty);
    });

    test('the attempt is recorded before the transport is called', () async {
      final s = service(opTimeout: const Duration(seconds: 5));
      await s.start();
      await s.setScope('p_1');
      fcm.hanging.add(tA);
      unawaited(s.sync(scope: 'p_1', source: 'apps', topics: {tA: 'ca_a'}));
      await pumpEventQueue();
      expect(fcm.calls, ['sub $tA']);
      expect(
        (jsonDecode(store.values[PushService.stateKey]!) as Map)['pending'],
        [tA],
      );
      // Killed mid-call: the next launch, signed out, still unsubscribes it.
      s.dispose();
      fcm.hanging.clear();
      fcm.calls.clear();
      final next = service();
      await next.start();
      // The start retries the subscribe for the restored profile first.
      await next.setScope(null);
      expect(fcm.calls, ['sub $tA', 'unsub $tA']);
      expect(fcm.topics, isEmpty);
      expect(next.pendingTopics, isEmpty);
    });

    test('a subscribe that timed out and later succeeds is confirmed, and '
        'an app uninstalled meanwhile is unsubscribed', () async {
      final s = service(opTimeout: short);
      await s.start();
      await s.setScope('p_1');
      fcm.hanging.addAll([tA, tB]);
      await s.sync(
        scope: 'p_1',
        source: 'apps',
        topics: {tA: 'ca_a', tB: 'ca_b'},
      );
      expect(s.pendingTopics, {tA, tB});

      fcm.hanging.clear();
      fcm.calls.clear();
      await s.sync(scope: 'p_1', source: 'apps', topics: {tA: 'ca_a'});
      expect(fcm.calls, unorderedEquals(['sub $tA', 'unsub $tB']));
      expect(s.subscribedTopics, {tA});
      expect(s.pendingTopics, isEmpty);
    });

    test('a failed unsubscribe of one is retried by the next sync, and by '
        'the next launch', () async {
      final s = service(opTimeout: short);
      await s.start();
      await s.setScope('p_1');
      fcm.hanging.add(tA);
      await s.sync(scope: 'p_1', source: 'apps', topics: {tA: 'ca_a'});
      fcm.hanging.clear();
      fcm.failing.add(tA);
      await s.setScope(null);
      expect(s.pendingTopics, {tA});

      // Another profile signs in; its first sync finishes the old cleanup.
      await s.setScope('p_2');
      expect(s.pendingTopics, {tA});
      fcm.failing.clear();
      fcm.calls.clear();
      await s.sync(scope: 'p_2', source: 'apps', topics: {tB: 'ca_b'});
      expect(fcm.calls, unorderedEquals(['unsub $tA', 'sub $tB']));
      expect(s.pendingTopics, isEmpty);
      expect(s.subscribedTopics, {tB});
    });

    test('an unsubscribe that timed out leaves the topic unconfirmed: '
        'following it again subscribes again', () async {
      final s = service(opTimeout: short);
      await s.start();
      await s.setScope('p_1');
      await s.sync(scope: 'p_1', source: 'apps', topics: {tA: 'ca_a'});
      fcm.hanging.add(tA);
      await s.sync(scope: 'p_1', source: 'apps', topics: {});
      expect(s.subscribedTopics, isEmpty);
      expect(s.pendingTopics, {tA});

      fcm.hanging.clear();
      fcm.calls.clear();
      await s.sync(scope: 'p_1', source: 'apps', topics: {tA: 'ca_a'});
      expect(fcm.calls, ['sub $tA']);
      expect(s.subscribedTopics, {tA});
    });
  });

  group('self-heal', () {
    test('a token refresh subscribes the desired set again and drops what '
        'is no longer wanted', () async {
      final s = await started();
      await s.sync(
        scope: 'p_1',
        source: 'apps',
        topics: {tA: 'ca_a', tB: 'ca_b'},
      );
      // A reset installation: FCM forgot every topic.
      fcm.topics.clear();
      fcm.calls.clear();
      fcm.tokenRefresh.add(null);
      await pumpEventQueue();
      await s.idle;
      expect(fcm.calls, unorderedEquals(['sub $tA', 'sub $tB']));
      expect(fcm.topics, {tA, tB});
      expect(s.subscribedTopics, {tA, tB});
      expect(s.pendingTopics, isEmpty);
    });

    test('a token refresh while signed out subscribes nothing', () async {
      final s = await started();
      await s.sync(scope: 'p_1', source: 'apps', topics: {tA: 'ca_a'});
      await s.setScope(null);
      fcm.calls.clear();
      fcm.tokenRefresh.add(null);
      await pumpEventQueue();
      await s.idle;
      expect(fcm.calls, isEmpty);
    });

    test('the confirmed set is subscribed again once per healEvery, not '
        'sooner', () async {
      final first = await started();
      await first.sync(scope: 'p_1', source: 'apps', topics: {tA: 'ca_a'});
      first.dispose();

      // A restored device: the state says subscribed, FCM does not.
      fcm.topics.clear();
      fcm.calls.clear();
      clock = clock.add(const Duration(days: 6, hours: 23));
      final early = await started();
      await early.sync(scope: 'p_1', source: 'apps', topics: {tA: 'ca_a'});
      expect(fcm.calls, isEmpty);
      early.dispose();

      clock = clock.add(const Duration(hours: 1));
      final due = await started();
      expect(fcm.calls, ['sub $tA']);
      expect(fcm.topics, {tA});
      fcm.calls.clear();
      await due.sync(scope: 'p_1', source: 'apps', topics: {tA: 'ca_a'});
      expect(fcm.calls, isEmpty);
      due.dispose();

      // A clock set back counts as due too, once.
      clock = clock.subtract(const Duration(days: 30));
      await started();
      expect(fcm.calls, ['sub $tA']);
    });

    test('a heal that fails stays pending and is retried by the next '
        'sync', () async {
      final s = await started();
      await s.sync(scope: 'p_1', source: 'apps', topics: {tA: 'ca_a'});
      fcm.failing.add(tA);
      fcm.tokenRefresh.add(null);
      await pumpEventQueue();
      await s.idle;
      expect(s.subscribedTopics, isEmpty);
      expect(s.pendingTopics, {tA});
      fcm.failing.clear();
      fcm.calls.clear();
      await s.sync(scope: 'p_1', source: 'apps', topics: {tA: 'ca_a'});
      expect(fcm.calls, ['sub $tA']);
      expect(s.subscribedTopics, {tA});
    });
  });

  group('topic names', () {
    test('only catalog topics are followed; another name is ignored '
        'silently, never retried and never accepted', () async {
      final s = await started();
      const bad = [
        'yyt.push.pc_1',
        'yyt.catalog.prod',
        'yyt.catalog.PROD.ca_a',
        'yyt.catalog.prod.ca_a.x',
        'yyt.catalog.prod.ca a',
        '/topics/yyt.catalog.prod.ca_a',
        'yyt.catalog.prod.ca_a\n',
        '',
      ];
      await s.sync(
        scope: 'p_1',
        source: 'apps',
        topics: {for (final t in bad) t: 'ca_x', tA: 'ca_a'},
      );
      await s.sync(
        scope: 'p_1',
        source: 'apps',
        topics: {for (final t in bad) t: 'ca_x', tA: 'ca_a'},
      );
      expect(fcm.calls, ['sub $tA']);
      expect(s.pendingTopics, isEmpty);
      expect(errors, isEmpty);
      expect(s.accept(catalogEvent('yyt.push.pc_1', 'ca_x')), isNull);
      expect(
        s.accept(const PushEvent(data: {'kind': 'catalog', 'appId': 'ca_x'})),
        isNull,
      );
      for (final t in [tA, 'yyt.catalog.dev-2.ca_A-b_9']) {
        expect(catalogTopicPattern.hasMatch(t), isTrue, reason: t);
      }
    });

    test(
      'a list with nothing but foreign names asks for no permission',
      () async {
        final s = await started();
        await s.sync(
          scope: 'p_1',
          source: 'apps',
          topics: {'yyt.push.pc_1': 'ca_a'},
        );
        expect(fcm.calls, isEmpty);
        expect(fcm.permissionRequests, 0);
      },
    );
  });

  group('sign-out and profile switch', () {
    test('signing out unsubscribes everything and forgets a pending '
        'tap', () async {
      final s = await started();
      await s.sync(
        scope: 'p_1',
        source: 'apps',
        topics: {tA: 'ca_a', tB: 'ca_b'},
      );
      fcm.opened.add(catalogEvent(tA, 'ca_a'));
      await pumpEventQueue();
      expect(s.pendingOpen.value, isNotNull);

      fcm.calls.clear();
      await s.setScope(null);
      expect(fcm.calls, unorderedEquals(['unsub $tA', 'unsub $tB']));
      expect(fcm.topics, isEmpty);
      expect(s.pendingOpen.value, isNull);
      final saved = jsonDecode(store.values[PushService.stateKey]!) as Map;
      expect(saved, {
        'scope': null,
        'sources': {},
        'subscribed': {},
        'pending': [],
        'healedAt': clock.millisecondsSinceEpoch,
      });
    });

    test('switching profile drops the old topics before the new list '
        'arrives, and a late report of the old profile is ignored', () async {
      final s = await started();
      await s.sync(scope: 'p_1', source: 'apps', topics: {tA: 'ca_a'});
      await s.setScope('p_2');
      expect(fcm.topics, isEmpty);

      await s.sync(scope: 'p_1', source: 'apps', topics: {tA: 'ca_a'});
      expect(fcm.topics, isEmpty);

      const dev = 'yyt.catalog.dev.ca_a';
      await s.sync(scope: 'p_2', source: 'apps', topics: {dev: 'ca_a'});
      expect(fcm.topics, {dev});
    });

    test('an unsubscribe that failed at sign-out is finished at the next '
        'start', () async {
      final s = await started();
      await s.sync(scope: 'p_1', source: 'apps', topics: {tA: 'ca_a'});
      fcm.failing.add(tA);
      await s.setScope(null);
      expect(fcm.topics, {tA});
      // Signed out, so nothing it delivers is accepted meanwhile.
      expect(s.accept(catalogEvent(tA, 'ca_a')), isNull);
      s.dispose();

      fcm.failing.clear();
      final next = service();
      await next.start();
      expect(fcm.topics, isEmpty);
    });
  });

  group('permission', () {
    test('is asked once, when the first installed app is known — not at '
        'start, not at sign-in, not for an empty list', () async {
      final s = await started();
      await s.sync(scope: 'p_1', source: 'apps', topics: {});
      expect(fcm.permissionRequests, 0);

      await s.sync(scope: 'p_1', source: 'apps', topics: {tA: 'ca_a'});
      expect(fcm.permissionRequests, 1);
      await s.sync(
        scope: 'p_1',
        source: 'apps',
        topics: {tA: 'ca_a', tB: 'ca_b'},
      );
      expect(fcm.permissionRequests, 1);
    });

    test('a decline is not asked again on a later launch, and the topics '
        'are followed all the same', () async {
      fcm.grant = false;
      final s = await started();
      await s.sync(scope: 'p_1', source: 'apps', topics: {tA: 'ca_a'});
      expect(fcm.permissionRequests, 1);
      expect(fcm.topics, {tA});
      s.dispose();

      final next = await started();
      await next.sync(
        scope: 'p_1',
        source: 'apps',
        topics: {tA: 'ca_a', tB: 'ca_b'},
      );
      expect(fcm.permissionRequests, 1);
      expect(fcm.topics, {tA, tB});
    });
  });

  group('permission flag', () {
    test('a prompt that never returned (the app was killed under it) is '
        'asked again on the next launch', () async {
      final s = await started();
      fcm.permissionHold = Completer<void>();
      unawaited(s.sync(scope: 'p_1', source: 'apps', topics: {tA: 'ca_a'}));
      await pumpEventQueue();
      expect(fcm.permissionRequests, 1);
      expect(store.values[PushService.askedKey], isNull);
      s.dispose();

      fcm.permissionHold = null;
      final next = await started();
      await next.sync(scope: 'p_1', source: 'apps', topics: {tA: 'ca_a'});
      expect(fcm.permissionRequests, 2);
      expect(store.values[PushService.askedKey], '1');
    });

    test('a prompt that failed is not repeated in the same launch, and is '
        'asked on the next', () async {
      final s = await started();
      fcm.permissionFails = true;
      await s.sync(scope: 'p_1', source: 'apps', topics: {tA: 'ca_a'});
      await s.sync(scope: 'p_1', source: 'apps', topics: {tA: 'ca_a'});
      expect(fcm.permissionRequests, 1);
      expect(errors, ['push_permission']);
      expect(store.values[PushService.askedKey], isNull);
      s.dispose();

      fcm.permissionFails = false;
      final next = await started();
      await next.sync(scope: 'p_1', source: 'apps', topics: {tA: 'ca_a'});
      expect(fcm.permissionRequests, 2);
    });
  });

  group('routing', () {
    late PushService s;
    late List<CatalogPush> seen;

    setUp(() async {
      s = await started();
      await s.sync(scope: 'p_1', source: 'apps', topics: {tA: 'ca_a'});
      seen = [];
      s.foreground.listen(seen.add);
    });

    test('a foreground notice of a followed app is delivered', () async {
      fcm.foreground.add(catalogEvent(tA, 'ca_a', version: '2.0.0'));
      await pumpEventQueue();
      expect(seen, hasLength(1));
      expect(seen.single.appId, 'ca_a');
      expect(seen.single.version, '2.0.0');
      expect(s.pendingOpen.value, isNull);
    });

    test('a tap becomes the pending open, handed over once', () async {
      fcm.opened.add(catalogEvent(tA, 'ca_a'));
      await pumpEventQueue();
      expect(seen, isEmpty);
      expect(s.pendingOpen.value?.appId, 'ca_a');
      expect(s.takePendingOpen()?.appId, 'ca_a');
      expect(s.takePendingOpen(), isNull);
    });

    test('everything else is dropped', () async {
      for (final e in [
        // Another kind on a followed topic.
        catalogEvent(tA, 'ca_a', kind: 'match'),
        // The same app id on another stage's topic.
        catalogEvent('yyt.catalog.dev.ca_a', 'ca_a'),
        // A followed topic naming another app.
        catalogEvent(tA, 'ca_b'),
        // An app nobody follows.
        catalogEvent(tB, 'ca_b'),
        // A direct (token) message for an app nobody follows.
        const PushEvent(data: {'kind': 'catalog', 'appId': 'ca_b'}),
        const PushEvent(data: {'kind': 'catalog'}),
        const PushEvent(data: {'kind': 'catalog', 'appId': 7}),
        const PushEvent(data: {}),
      ]) {
        fcm.foreground.add(e);
        fcm.opened.add(e);
      }
      await pumpEventQueue();
      expect(seen, isEmpty);
      expect(s.pendingOpen.value, isNull);
    });

    test('a notice without a topic is matched by its app id', () {
      const e = PushEvent(
        data: {'kind': 'catalog', 'appId': 'ca_a', 'version': '3'},
      );
      expect(s.accept(e)?.version, '3');
    });

    test('nothing is accepted after the profile changed', () async {
      await s.setScope('p_2');
      expect(s.accept(catalogEvent(tA, 'ca_a')), isNull);
    });
  });

  test('a tap that started the app is pending once the service started, '
      'checked against the persisted topics', () async {
    final first = await started();
    await first.sync(scope: 'p_1', source: 'apps', topics: {tA: 'ca_a'});
    first.dispose();

    fcm.initial = catalogEvent(tA, 'ca_a', version: '9');
    final cold = service();
    await cold.start();
    expect(cold.pendingOpen.value?.version, '9');
    // The profile the launch signs in with is the one that followed it.
    await cold.setScope('p_1');
    expect(cold.pendingOpen.value?.appId, 'ca_a');

    // A launch into another profile drops it.
    fcm.initial = catalogEvent(tA, 'ca_a');
    final other = service();
    await other.start();
    await other.setScope('p_9');
    expect(other.pendingOpen.value, isNull);
  });

  group('without a config', () {
    test('the build defines are absent in tests, so Firebase is never '
        'touched', () async {
      expect(PushConfig.fromBuild.isComplete, isFalse);
      expect(await connectFirebasePush(), isNull);
      expect(
        const PushConfig(
          projectId: 'p',
          senderId: '1',
          appId: '',
          apiKey: 'k',
        ).isComplete,
        isFalse,
      );
    });

    test('a service without a transport does nothing and stores '
        'nothing', () async {
      for (final s in [
        PushService(store: store),
        PushService(connect: () async => null, store: store),
        PushService(connect: () async => throw StateError('x'), store: store),
      ]) {
        await s.start();
        await s.setScope('p_1');
        await s.sync(scope: 'p_1', source: 'apps', topics: {tA: 'ca_a'});
        await s.setScope(null);
        expect(s.enabled, isFalse);
        expect(s.subscribedTopics, isEmpty);
        expect(s.takePendingOpen(), isNull);
        expect(s.accept(catalogEvent(tA, 'ca_a')), isNull);
        s.dispose();
      }
      expect(store.writes, 0);
      expect(fcm.calls, isEmpty);
      expect(fcm.permissionRequests, 0);
    });
  });
}
