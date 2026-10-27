import 'package:flutter_test/flutter_test.dart';
import 'package:yyt_console/auth/app_handoff.dart';

const token = 'shr_0123456789abcdef0123456789abcdef';

void main() {
  group('ShareLink.tryParse', () {
    test('accepts a token on both console hosts and both schemes', () {
      for (final scheme in ['https', 'yytconsole']) {
        for (final host in AppHandoffLink.consoleHosts) {
          final l = ShareLink.tryParse(Uri.parse('$scheme://$host/i/$token'));
          expect(l, isNotNull, reason: '$scheme://$host');
          expect(l!.server, 'https://$host');
          expect(l.ref, token);
          expect(l.isToken, isTrue);
          expect(l.toString(), isNot(contains(token)));
        }
      }
    });

    test('accepts an app id and lowercases the host', () {
      final l = ShareLink.tryParse(
        Uri.parse('https://CONSOLE.yyt.life/i/ca_01ABC-xyz'),
      );
      expect(l, isNotNull);
      expect(l!.server, 'https://console.yyt.life');
      expect(l.ref, 'ca_01ABC-xyz');
      expect(l.isToken, isFalse);
      expect(l.toString(), contains('ca_01ABC-xyz'));
      expect(
        ShareLink.tryParse(Uri.parse('https://console.yyt.life/i/${'a' * 64}')),
        isNotNull,
      );
    });

    test('ignores a query or fragment the messenger appended', () {
      expect(
        ShareLink.tryParse(
          Uri.parse('https://console.yyt.life/i/$token?openExternalBrowser=1'),
        )?.ref,
        token,
      );
    });

    test('refuses other schemes, hosts, ports and user info', () {
      final bad = <String>[
        'http://console.yyt.life/i/$token',
        'intent://console.yyt.life/i/$token',
        'javascript://console.yyt.life/i/$token',
        'https://evil.example/i/$token',
        'https://console.yyt.life.evil.example/i/$token',
        'https://link.yyt.life/i/$token',
        'https://link-dev.yyt.life/i/$token',
        'yytconsole://evil.example/i/$token',
        'https://console.yyt.life:8443/i/$token',
        'https://user@console.yyt.life/i/$token',
      ];
      for (final u in bad) {
        expect(ShareLink.tryParse(Uri.parse(u)), isNull, reason: u);
      }
    });

    test('refuses other paths and malformed refs', () {
      final bad = <String>[
        'https://console.yyt.life/i/',
        'https://console.yyt.life/i',
        'https://console.yyt.life/i/$token/',
        'https://console.yyt.life/i/$token/x',
        'https://console.yyt.life/ui/i/$token',
        'https://console.yyt.life/x/$token',
        'https://console.yyt.life/app-open?code=$token',
        'https://console.yyt.life//i/$token',
        // Malformed tokens never fall back to the app-id rule.
        'https://console.yyt.life/i/shr_0123',
        'https://console.yyt.life/i/shr_0123456789ABCDEF0123456789ABCDEF',
        'https://console.yyt.life/i/${token}0',
        // App ids: charset and length.
        'https://console.yyt.life/i/${'a' * 65}',
        'https://console.yyt.life/i/ca.app',
        'https://console.yyt.life/i/ca%2Fapp',
        'https://console.yyt.life/i/..',
      ];
      for (final u in bad) {
        expect(ShareLink.tryParse(Uri.parse(u)), isNull, reason: u);
      }
    });

    test('a share link is not a handoff link and vice versa', () {
      final share = Uri.parse('yytconsole://console.yyt.life/i/$token');
      expect(AppHandoffLink.tryParse(share), isNull);
      final handoff = Uri.parse(
        'yytconsole://console.yyt.life/app-open?code=hoff_0123456789abcdef0123456789abcdef',
      );
      expect(ShareLink.tryParse(handoff), isNull);
    });
  });
}
