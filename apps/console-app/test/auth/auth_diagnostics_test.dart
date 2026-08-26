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
}
