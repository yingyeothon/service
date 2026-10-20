import 'dart:async';
import 'dart:convert';

import 'package:app_links/app_links.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:yyt_console/auth/app_handoff.dart';

const code = 'hoff_0123456789abcdef0123456789abcdef';
final token = 'yyt_${'0123456789abcdef' * 3}';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('AppHandoffLink.tryParse', () {
    test('accepts the console hosts and derives the server from the host', () {
      final l = AppHandoffLink.tryParse(
        Uri.parse('https://console-dev.yyt.life/app-open?code=$code'),
      );
      expect(l, isNotNull);
      expect(l!.server, 'https://console-dev.yyt.life');
      expect(l.code, code);
      expect(l.toString(), isNot(contains(code)));
      expect(
        AppHandoffLink.tryParse(
          Uri.parse('https://CONSOLE.yyt.life/app-open?code=$code'),
        )?.server,
        'https://console.yyt.life',
      );
    });

    test('accepts the custom scheme the SPA intent URL targets', () {
      final l = AppHandoffLink.tryParse(
        Uri.parse('yytconsole://console-dev.yyt.life/app-open?code=$code'),
      );
      expect(l, isNotNull);
      expect(l!.server, 'https://console-dev.yyt.life');
      expect(l.code, code);
      expect(
        AppHandoffLink.tryParse(
          Uri.parse('yytconsole://evil.example/app-open?code=$code'),
        ),
        isNull,
      );
    });

    test('maps each iOS link host to its console host', () {
      expect(AppHandoffLink.linkHosts, {
        'link.yyt.life': 'console.yyt.life',
        'link-dev.yyt.life': 'console-dev.yyt.life',
      });
      for (final e in AppHandoffLink.linkHosts.entries) {
        expect(AppHandoffLink.consoleHosts, contains(e.value));
        final l = AppHandoffLink.tryParse(
          Uri.parse('https://${e.key}/app-open?code=$code'),
        );
        expect(l, isNotNull, reason: e.key);
        expect(l!.server, 'https://${e.value}');
        expect(l.code, code);
      }
      expect(
        AppHandoffLink.tryParse(
          Uri.parse('https://LINK-DEV.yyt.life/app-open?code=$code'),
        )?.server,
        'https://console-dev.yyt.life',
      );
    });

    test('refuses a link host on anything but https /app-open', () {
      final bad = <String>[
        // iOS gets no custom scheme: another app could claim it.
        'yytconsole://link.yyt.life/app-open?code=$code',
        'yytconsole://link-dev.yyt.life/app-open?code=$code',
        'http://link.yyt.life/app-open?code=$code',
        'https://link.yyt.life.evil.example/app-open?code=$code',
        'https://evil-link.yyt.life/app-open?code=$code',
        'https://link-prod.yyt.life/app-open?code=$code',
        'https://link.yyt.life/ui/app-open?code=$code',
        'https://link.yyt.life/app-open/?code=$code',
        'https://link.yyt.life/?code=$code',
        'https://link-dev.yyt.life:8443/app-open?code=$code',
        'https://user@link.yyt.life/app-open?code=$code',
        'https://user:pw@link-dev.yyt.life/app-open?code=$code',
        'https://link.yyt.life/app-open?code=hoff_short',
        'https://link.yyt.life/app-open?code=${code.toUpperCase()}',
        'https://link.yyt.life/app-open?code=$token',
        'https://link.yyt.life/app-open',
      ];
      for (final u in bad) {
        expect(AppHandoffLink.tryParse(Uri.parse(u)), isNull, reason: u);
      }
    });

    test('keeps the Android links unchanged', () {
      for (final scheme in ['https', 'yytconsole']) {
        for (final host in AppHandoffLink.consoleHosts) {
          final l = AppHandoffLink.tryParse(
            Uri.parse('$scheme://$host/app-open?code=$code'),
          );
          expect(l?.server, 'https://$host', reason: '$scheme://$host');
          expect(l?.code, code);
        }
      }
    });

    test('ignores anything an exported activity might be handed', () {
      final bad = <String>[
        'https://evil.example/app-open?code=$code',
        'https://console.yyt.life.evil.example/app-open?code=$code',
        'http://console.yyt.life/app-open?code=$code',
        'yytconsole2://console.yyt.life/app-open?code=$code',
        'https://console.yyt.life/ui/app-open?code=$code',
        'https://console.yyt.life/app-open/?code=$code',
        'https://console.yyt.life:8443/app-open?code=$code',
        // (`:443` is the scheme default and collapses to no port in Dart.)
        'https://user@console.yyt.life/app-open?code=$code',
        'https://console.yyt.life/app-open?code=hoff_short',
        'https://console.yyt.life/app-open?code=$token',
        'https://console.yyt.life/app-open',
      ];
      for (final u in bad) {
        expect(AppHandoffLink.tryParse(Uri.parse(u)), isNull, reason: u);
      }
    });
  });

  group('exchangeAppHandoff', () {
    final link = AppHandoffLink.tryParse(
      Uri.parse('https://console-dev.yyt.life/app-open?code=$code'),
    )!;

    test(
      'posts the code without an Authorization header and returns the key',
      () async {
        http.Request? seen;
        final client = MockClient((req) async {
          seen = req;
          return http.Response(
            jsonEncode({
              'token': token,
              'tokenId': 'tok_1',
              'name': 'app handoff 2026-09-29 12:00',
              'member': {'id': 'm_1', 'login': 'alice', 'role': 'member'},
            }),
            201,
            headers: {'content-type': 'application/json'},
          );
        });
        final r = await exchangeAppHandoff(link, client: client);
        expect(r.apiKey, token);
        expect(r.tokenId, 'tok_1');
        expect(r.login, 'alice');
        expect(seen!.method, 'POST');
        expect(
          seen!.url.toString(),
          'https://console-dev.yyt.life/auth/app-handoff/exchange',
        );
        expect(
          seen!.headers.keys.map((k) => k.toLowerCase()),
          isNot(contains('authorization')),
        );
        expect(jsonDecode(seen!.body), {'code': code});
      },
    );

    test('maps 410, 403 and 409 to their messages', () async {
      for (final status in [410, 403, 409, 404, 500]) {
        final client = MockClient(
          (_) async => http.Response('{"error":{"code":"x"}}', status),
        );
        await expectLater(
          exchangeAppHandoff(link, client: client),
          throwsA(
            isA<AppHandoffException>().having(
              (e) => e.status,
              'status',
              status,
            ),
          ),
        );
      }
    });

    test('revokes a declined token with the token itself as bearer', () async {
      http.Request? seen;
      final client = MockClient((req) async {
        seen = req;
        return http.Response('', 204);
      });
      const r = AppHandoffResult(apiKey: 'yyt_k', tokenId: 'tok_9', login: 'a');
      expect(await revokeHandoffToken(link, r, client: client), isTrue);
      expect(seen!.method, 'DELETE');
      expect(seen!.url.toString(), 'https://console-dev.yyt.life/tokens/tok_9');
      expect(seen!.headers['Authorization'], 'Bearer yyt_k');
      final failing = MockClient((_) async => http.Response('', 404));
      expect(await revokeHandoffToken(link, r, client: failing), isFalse);
    });

    test('refuses a 201 without a well-formed token', () async {
      final client = MockClient(
        (_) async => http.Response('{"token":"nope"}', 201),
      );
      await expectLater(
        exchangeAppHandoff(link, client: client),
        throwsA(isA<AppHandoffException>()),
      );
    });
  });

  group('AppHandoffQueue', () {
    test('buffers until ready, dedupes by code, runs one at a time', () async {
      final handled = <String>[];
      final q = AppHandoffQueue((l) async {
        handled.add(l.code);
        await Future<void>.delayed(Duration.zero);
      });
      final uri = Uri.parse('https://console.yyt.life/app-open?code=$code');
      expect(q.offer(uri), isTrue);
      expect(q.offer(uri), isTrue); // initial link + stream duplicate
      expect(
        q.offer(Uri.parse('https://evil.example/app-open?code=$code')),
        isFalse,
      );
      expect(handled, isEmpty);
      q.ready();
      await Future<void>.delayed(const Duration(milliseconds: 10));
      expect(handled, [code]);
      final other = 'hoff_${'f' * 32}';
      q.offer(Uri.parse('https://console.yyt.life/app-open?code=$other'));
      await Future<void>.delayed(const Duration(milliseconds: 10));
      expect(handled, [code, other]);
      // Handled codes are forgotten: the SPA's retry link is not swallowed.
      expect(q.offer(uri), isTrue);
      await Future<void>.delayed(const Duration(milliseconds: 10));
      expect(handled, [code, other, code]);
    });

    test('takes the launch link from uriLinkStream (iOS cold start)', () async {
      // The iOS plugin stores the Universal Link that launched the app and
      // emits it to the first listener of its event channel.
      const events = EventChannel('com.llfbandit.app_links/events');
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockStreamHandler(
        events,
        MockStreamHandler.inline(
          onListen: (_, sink) =>
              sink.success('https://link-dev.yyt.life/app-open?code=$code'),
        ),
      );
      addTearDown(() => messenger.setMockStreamHandler(events, null));
      final handled = <AppHandoffLink>[];
      final q = AppHandoffQueue((l) async => handled.add(l));
      final offered = Completer<bool>();
      final sub = AppLinks().uriLinkStream.listen(
        (uri) => offered.complete(q.offer(uri)),
      );
      addTearDown(sub.cancel);
      expect(await offered.future, isTrue);
      expect(handled, isEmpty); // held until the profiles are loaded
      q.ready();
      await Future<void>.delayed(const Duration(milliseconds: 10));
      expect(handled.single.server, 'https://console-dev.yyt.life');
      expect(handled.single.code, code);
    });
  });
}
