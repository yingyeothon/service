import 'dart:math';

import 'package:intl/intl.dart';

/// Server timestamps are UTC (unix seconds); every screen shows them in the
/// device's time zone.
String formatLocalTime(DateTime t, {String pattern = 'yyyy.MM.dd HH:mm'}) =>
    DateFormat(pattern).format(t.toLocal());

/// `3일 후` / `5시간 전`, rounded like the console SPA's `fmtRelative`
/// (days from 24 h, hours from 1 h, else minutes with a floor of one).
String formatRelative(DateTime t, {DateTime? now}) {
  final diff = t.difference(now ?? DateTime.now()).inSeconds;
  final abs = diff.abs();
  final unit =
      abs >= 86400
          ? '${(abs / 86400).round()}일'
          : abs >= 3600
          ? '${(abs / 3600).round()}시간'
          : '${max(1, (abs / 60).round())}분';
  return diff >= 0 ? '$unit 후' : '$unit 전';
}

/// `expires_at` of a channel granted no expiry (9999-12-31T23:59:59Z; the
/// console's `CHANNEL_NO_EXPIRY_SEC`). Every other expiry is a real date.
const channelNoExpirySec = 253402300799;

/// Whether a channel expiry is the no-expiry sentinel.
bool isNoExpiry(DateTime t) =>
    t.millisecondsSinceEpoch ~/ 1000 >= channelNoExpirySec;
