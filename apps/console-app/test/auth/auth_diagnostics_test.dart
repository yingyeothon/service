import 'dart:async';
import 'dart:io';

import 'package:yyt_console/auth/auth_diagnostics.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

void main() {
  AuthRequestContext contextFor(String operation) {
    return AuthRequestContext(
      requestId: 'req-test',
      operation: operation,
      method: 'POST',
      uri: Uri.parse('https://dev-cata.yyt.life/auth/device/start'),
      timestamp: DateTime.utc(2026, 2, 11),
      attempt: 1,
    );
  }

  group('AuthErrorClassifier', () {
    test('classifies DNS lookup failure', () {
      final err = SocketException(
        'Failed host lookup',
        osError: const OSError('No address associated with hostname', 7),
      );
      expect(AuthErrorClassifier.classify(err), AuthFailureKind.clientDns);
    });

    test('classifies timeout', () {
      expect(
        AuthErrorClassifier.classify(TimeoutException('timeout')),
        AuthFailureKind.timeout,
      );
    });

    test('classifies TLS handshake failure', () {
      expect(
        AuthErrorClassifier.classify(HandshakeException('tls fail')),
        AuthFailureKind.tls,
      );
    });

    test('classifies HTTP response error when status is present', () {
      expect(
        AuthErrorClassifier.classify(Exception('500'), httpStatus: 500),
        AuthFailureKind.serverHttp,
      );
    });

    test('classifies client exception DNS message', () {
      final err = http.ClientException(
        "ClientException with SocketException: Failed host lookup: 'dev-cata.yyt.life' (OS Error: No address associated with hostname, errno = 7)",
      );
      expect(AuthErrorClassifier.classify(err), AuthFailureKind.clientDns);
    });

    test('classifies parse errors', () {
      expect(
        AuthErrorClassifier.classify(const FormatException('bad json')),
        AuthFailureKind.responseParse,
      );
    });
  });

  test('createError includes diagnostic id and preserved context', () {
    final context = contextFor('poll_device_token');
    final error = AuthDiagnosticLogger.createError(
      context: context,
      error: Exception('network down'),
      stackTrace: StackTrace.current,
      message: '네트워크 연결 실패',
    );

    expect(error.diagnosticId, startsWith('diag-'));
    expect(error.context.operation, 'poll_device_token');
    expect(error.message, '네트워크 연결 실패');
  });

  test('redact hides channel secrets, API keys and provider secrets', () {
    final hex = '0123456789abcdef' * 4;
    final out = AuthDiagnosticLogger.redact(
      'created {"id":"auth_1","secret":"$hex"} '
      '{apiKey: $hex, name: n} clientSecret=abc123 bare $hex.',
    );
    expect(out, isNot(contains(hex)));
    expect(out, isNot(contains('abc123')));
    expect(out, contains('"secret":"***"'));
    expect(out, contains('apiKey: ***'));
    expect(out, contains('clientSecret=***'));
    expect(out, contains('bare (redacted).'));
    // Ids and ordinary words survive.
    expect(out, contains('"id":"auth_1"'));
    expect(out, contains('name: n'));
    expect(
      AuthDiagnosticLogger.redact('the secret is required'),
      'the secret is required',
    );
    // A 63-char run is not a credential; a 65-char one is not ours either.
    expect(AuthDiagnosticLogger.redact(hex.substring(1)), hex.substring(1));
    expect(AuthDiagnosticLogger.redact('${hex}0'), '${hex}0');
  });

  test('redacts a web → app handoff code and a code field', () {
    const code = 'hoff_0123456789abcdef0123456789abcdef';
    final out = AuthDiagnosticLogger.redact(
      'uri=https://c/app-open?code=$code {"code":"$code"}',
    );
    expect(out, isNot(contains(code)));
    // A bare code (no `code=` key in front) is caught by the hoff_ rule.
    expect(
      AuthDiagnosticLogger.redact('link $code'),
      'link hoff_...(redacted)',
    );
  });
}
