/// Waits until iOS has handed Firebase an APNs token: before that a topic
/// subscription fails (`apns-token-not-set`). Reads [read] up to [tries]
/// times, [step] apart; `false` when the token never came — the caller's
/// operation then fails and the push service retries it on the next sync.
Future<bool> waitForApnsToken(
  Future<String?> Function() read, {
  int tries = 10,
  Duration step = const Duration(seconds: 1),
  Future<void> Function(Duration) delay = Future<void>.delayed,
}) async {
  for (var i = 0; i < tries; i++) {
    if (i > 0) await delay(step);
    try {
      if ((await read()) != null) return true;
    } catch (_) {
      // Not ready yet reads the same as no token.
    }
  }
  return false;
}

/// One [waitForApnsToken] at a time for a transport: concurrent topic
/// operations share the wait in flight, a token once seen is not read again,
/// and a miss is forgotten so the next operation waits anew.
class ApnsGate {
  ApnsGate(this._read, {Future<void> Function(Duration)? delay})
    : _delay = delay ?? Future<void>.delayed;

  final Future<String?> Function() _read;
  final Future<void> Function(Duration) _delay;
  Future<bool>? _inFlight;
  bool _ready = false;

  Future<bool> ready() {
    if (_ready) return Future.value(true);
    return _inFlight ??= waitForApnsToken(_read, delay: _delay).then((ok) {
      _inFlight = null;
      _ready = ok;
      return ok;
    });
  }
}
