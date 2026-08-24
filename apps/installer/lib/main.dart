import 'dart:async';
import 'dart:ui';

import 'package:catalog/app_theme.dart';
import 'package:catalog/auth/auth_diagnostics.dart';
import 'package:catalog/auth/auth_state.dart';
import 'package:catalog/login_screen.dart';
import 'package:catalog/update_app.dart';
import 'package:flutter/material.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();

  FlutterError.onError = (FlutterErrorDetails details) {
    FlutterError.presentError(details);
    AuthDiagnosticLogger.logUnhandled(
      scope: 'flutter_error',
      error: details.exception,
      stackTrace: details.stack ?? StackTrace.current,
    );
  };

  PlatformDispatcher.instance.onError = (Object error, StackTrace stackTrace) {
    AuthDiagnosticLogger.logUnhandled(
      scope: 'platform_dispatcher',
      error: error,
      stackTrace: stackTrace,
    );
    return false;
  };

  runZonedGuarded(
    () {
      runApp(const CatalogApp());
    },
    (Object error, StackTrace stackTrace) {
      AuthDiagnosticLogger.logUnhandled(
        scope: 'zone_guard',
        error: error,
        stackTrace: stackTrace,
      );
    },
  );
}

class CatalogApp extends StatefulWidget {
  const CatalogApp({super.key});

  @override
  State<CatalogApp> createState() => _CatalogAppState();
}

class _CatalogAppState extends State<CatalogApp> {
  late final AuthState _authState;

  @override
  void initState() {
    super.initState();
    _authState = AuthState();
    _authState.addListener(_onAuthStateChanged);
  }

  @override
  void dispose() {
    _authState.removeListener(_onAuthStateChanged);
    _authState.dispose();
    super.dispose();
  }

  void _onAuthStateChanged() {
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: buildCatalogTheme(),
      home:
          _authState.isLoggedIn
              ? UpdaterApp(authState: _authState)
              : LoginScreen(authState: _authState),
    );
  }
}
