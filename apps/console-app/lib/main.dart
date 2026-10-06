import 'dart:async';
import 'dart:ui';

import 'package:app_links/app_links.dart';
import 'package:http/http.dart' as http;
import 'package:yyt_console/app_theme.dart';
import 'package:yyt_console/auth/app_handoff.dart';
import 'package:yyt_console/auth/auth_diagnostics.dart';
import 'package:yyt_console/auth/auth_state.dart';
import 'package:yyt_console/login_screen.dart';
import 'package:yyt_console/home_shell.dart';
import 'package:yyt_console/push/firebase_push_messaging.dart';
import 'package:yyt_console/push/push_service.dart';
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
      // Push is on only in a build that carries the Firebase defines
      // (README *Build*); without them `connectFirebasePush` answers null
      // and the service does nothing.
      runApp(
        CatalogApp(
          push: PushService(
            connect: connectFirebasePush,
            // The type only: an error's text may quote a topic or the config.
            onError: (scope, error, stackTrace) =>
                AuthDiagnosticLogger.logUiFailure(
                  scope: scope,
                  error: StateError('${error.runtimeType}'),
                  stackTrace: stackTrace,
                ),
          ),
        ),
      );
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
  const CatalogApp({super.key, this.push});

  /// Update notices; `null` in tests.
  final PushService? push;

  @override
  State<CatalogApp> createState() => _CatalogAppState();
}

class _CatalogAppState extends State<CatalogApp> {
  late final AuthState _authState;
  final _navigatorKey = GlobalKey<NavigatorState>();
  final _messengerKey = GlobalKey<ScaffoldMessengerState>();
  String? _shownProfileId;
  late final AppHandoffQueue _handoffs;
  StreamSubscription<Uri>? _links;

  @override
  void initState() {
    super.initState();
    _authState = AuthState();
    _authState.addListener(_onAuthStateChanged);
    _handoffs = AppHandoffQueue(_handleHandoff);
    // Connects and reads the notification that started the app, if one did;
    // nothing is asked of the user here (the permission prompt waits for an
    // installed app, see PushService.sync).
    widget.push?.start();
    // Web → app sign-in links (todo/49). The stream carries the launch link
    // too; the queue holds it until the saved profiles are loaded.
    _links = AppLinks().uriLinkStream.listen(
      (uri) {
        if (!_handoffs.offer(uri)) {
          AuthDiagnosticLogger.logUiFailure(
            scope: 'app_link_ignored',
            error: StateError('not a console handoff link'),
            stackTrace: StackTrace.current,
            extras: {'scheme': uri.scheme, 'host': uri.host, 'path': uri.path},
          );
        }
      },
      onError: (Object e, StackTrace st) => AuthDiagnosticLogger.logUiFailure(
        scope: 'app_link_stream',
        error: e,
        stackTrace: st,
      ),
    );
  }

  @override
  void dispose() {
    _links?.cancel();
    _authState.removeListener(_onAuthStateChanged);
    _authState.dispose();
    widget.push?.dispose();
    super.dispose();
  }

  void _onAuthStateChanged() {
    // `home` only swaps the root route; pushed screens (issue detail, app
    // detail) would otherwise stay on top after a profile switch or removal.
    if (_authState.activeProfile?.id != _shownProfileId) {
      _shownProfileId = _authState.activeProfile?.id;
      _navigatorKey.currentState?.popUntil((route) => route.isFirst);
    }
    if (_authState.loaded) {
      _handoffs.ready();
      // Topics belong to a profile: signing out or switching drops them.
      widget.push?.setScope(_authState.activeProfile?.id);
    }
    setState(() {});
  }

  /// One handoff link. The code is exchanged first so the confirm can name
  /// the account it would add: a link can arrive from any page or app (a
  /// stranger's own code in a chat message), and a dialog naming only the
  /// host cannot tell the user that. Declining revokes the token the
  /// exchange minted; accepting adds the profile exactly as a scanned QR
  /// would be.
  Future<void> _handleHandoff(AppHandoffLink link) async {
    final host = Uri.parse(link.server).host;
    final client = http.Client();
    try {
      final AppHandoffResult r;
      try {
        r = await exchangeAppHandoff(link, client: client);
      } on AppHandoffException catch (e, st) {
        AuthDiagnosticLogger.logUiFailure(
          scope: 'app_handoff_exchange',
          error: e,
          stackTrace: st,
          extras: {'status': e.status},
        );
        _messengerKey.currentState?.showSnackBar(
          SnackBar(content: Text(e.message)),
        );
        return;
      }
      final context = _navigatorKey.currentContext;
      final ok = context == null || !context.mounted
          ? null
          : await showDialog<bool>(
              context: context,
              builder: (ctx) => AlertDialog(
                title: const Text('콘솔 로그인 추가'),
                content: Text(
                  '$host 의 ${r.login} 계정으로 이 앱에 로그인할까요?\n'
                  '본인이 콘솔에서 Open app을 누른 것이 아니거나 '
                  '이 계정이 본인 것이 아니면 취소하세요.',
                ),
                actions: [
                  TextButton(
                    onPressed: () => Navigator.of(ctx).pop(false),
                    child: const Text('취소'),
                  ),
                  FilledButton(
                    onPressed: () => Navigator.of(ctx).pop(true),
                    child: Text('${r.login} 로 로그인'),
                  ),
                ],
              ),
            );
      if (ok != true) {
        final revoked = await revokeHandoffToken(link, r, client: client);
        AuthDiagnosticLogger.logUiFailure(
          scope: 'app_handoff_declined',
          error: StateError(ok == null ? 'no navigator' : 'user declined'),
          stackTrace: StackTrace.current,
          extras: {'revoked': revoked},
        );
        _messengerKey.currentState?.showSnackBar(
          SnackBar(
            content: Text(
              revoked
                  ? '로그인을 취소했습니다. 발급된 토큰은 회수했습니다.'
                  : '로그인을 취소했습니다. 콘솔 > API tokens에서 방금 발급된 토큰을 확인하세요.',
            ),
          ),
        );
        return;
      }
      final profile = await _authState.addProfile(
        server: link.server,
        apiKey: r.apiKey,
      );
      _messengerKey.currentState?.showSnackBar(
        SnackBar(content: Text('${profile.login} @ $host 로 로그인했습니다.')),
      );
    } catch (e, st) {
      AuthDiagnosticLogger.logUiFailure(
        scope: 'app_handoff',
        error: e,
        stackTrace: st,
      );
      final message = e is AuthDiagnosticError ? e.message : '앱 로그인 실패: $e';
      _messengerKey.currentState?.showSnackBar(
        SnackBar(content: Text(message)),
      );
    } finally {
      client.close();
    }
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      navigatorKey: _navigatorKey,
      scaffoldMessengerKey: _messengerKey,
      theme: buildCatalogTheme(),
      home: !_authState.loaded
          ? const Scaffold(body: Center(child: CircularProgressIndicator()))
          : _authState.isLoggedIn
          // Keyed by profile so every screen reloads with the new token.
          ? HomeShell(
              key: ValueKey(_authState.activeProfile!.id),
              authState: _authState,
              push: widget.push,
            )
          : LoginScreen(authState: _authState),
    );
  }
}
