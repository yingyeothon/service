// Throwaway capture app for tracer todo/85 P2: sends every item kind a
// sentry_flutter 9.x debug build sends, to a local `tracer serve` dump.
// Options copy chessrigado's Diagnostics.configure (debug mode).
import 'dart:async';
import 'dart:isolate';

import 'package:flutter/material.dart';
import 'package:sentry/sentry.dart' as dart_sentry;
import 'package:sentry_flutter/sentry_flutter.dart';

const dsn = String.fromEnvironment('DEBUG_SENTRY_DSN');

Future<void> main() async {
  await SentryFlutter.init((options) {
    options
      ..dsn = dsn
      ..environment = 'debug'
      ..release = 'capture@1.0.0+1'
      ..dist = 'abc1234'
      ..sendDefaultPii = true
      ..maxBreadcrumbs = 500
      ..enablePrintBreadcrumbs = true
      ..enableAutoNativeBreadcrumbs = true
      ..enableUserInteractionBreadcrumbs = true
      ..enableAppLifecycleBreadcrumbs = true
      ..reportSilentFlutterErrors = true
      ..attachScreenshot = true
      // ignore: experimental_member_use
      ..attachViewHierarchy = true
      ..enableLogs = true
      ..tracesSampleRate = 1.0
      ..enableAutoSessionTracking = true
      ..debug = true;
    options.replay
      ..sessionSampleRate = 1.0
      ..onErrorSampleRate = 1.0;
    options.privacy
      ..maskAllText = false
      ..maskAllImages = false;
  }, appRunner: () => runApp(SentryWidget(child: const CaptureApp())));
}

class CaptureApp extends StatefulWidget {
  const CaptureApp({super.key});
  @override
  State<CaptureApp> createState() => _CaptureAppState();
}

class _CaptureAppState extends State<CaptureApp> {
  String status = 'starting';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _run());
  }

  void _step(String s) {
    debugPrint('CAPTURE: $s');
    setState(() => status = s);
  }

  Future<void> _run() async {
    await Future<void>.delayed(const Duration(seconds: 3));
    _step('trace');
    await Sentry.addBreadcrumb(Breadcrumb(category: 'board.pointer', message: 'tap e2', data: {'x': 12, 'y': 34}));
    Sentry.logger.info('[board.pointer] tap e2', attributes: {'square': SentryAttribute.string('e2')});
    Sentry.logger.warn('capture warning log', attributes: {'n': SentryAttribute.int(3)});

    _step('transaction');
    final tx = Sentry.startTransaction('capture.flow', 'ui.load', bindToScope: true);
    final span = tx.startChild('db.query', description: 'load board');
    await Future<void>.delayed(const Duration(milliseconds: 120));
    await span.finish();
    await tx.finish();

    _step('report');
    final reportId = await Sentry.captureMessage('capture report: rejected move', level: SentryLevel.warning,
        withScope: (scope) {
      scope.setContexts('details', {'from': 'e2', 'to': 'e5'});
      scope.setTag('feature', 'board');
      scope.fingerprint = ['{{ default }}', 'rejected-move'];
    });

    _step('exception');
    try {
      throw StateError('capture exception');
    } catch (e, st) {
      await Sentry.captureException(e, stackTrace: st);
    }

    _step('feedback');
    await Sentry.captureFeedback(SentryFeedback(message: 'capture feedback note', associatedEventId: reportId));

    _step('isolate');
    await Isolate.run(() => _backgroundIsolate(dsn));

    _step('flush');
    await Future<void>.delayed(const Duration(seconds: 12));
    _step('done');
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
        home: Scaffold(body: Center(child: Text('capture: $status', key: const Key('status')))),
      );
}

// sentry-dart's own HttpTransport (gzip) from a background isolate.
Future<void> _backgroundIsolate(String dsn) async {
  await dart_sentry.Sentry.init((o) {
    o
      ..dsn = dsn
      ..environment = 'debug'
      ..release = 'capture@1.0.0+1'
      ..enableLogs = true;
  });
  dart_sentry.Sentry.logger.info('background isolate log', attributes: {'isolate': dart_sentry.SentryAttribute.string('bg')});
  await dart_sentry.Sentry.addBreadcrumb(dart_sentry.Breadcrumb(category: 'ble', message: 'notify 0x2a37'));
  await dart_sentry.Sentry.captureMessage('background isolate report', level: dart_sentry.SentryLevel.warning);
  await Future<void>.delayed(const Duration(seconds: 6));
  await dart_sentry.Sentry.close();
}
