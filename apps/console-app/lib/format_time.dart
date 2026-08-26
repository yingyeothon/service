import 'package:intl/intl.dart';

/// Server timestamps are UTC (unix seconds); every screen shows them in the
/// device's time zone.
String formatLocalTime(DateTime t, {String pattern = 'yyyy.MM.dd HH:mm'}) =>
    DateFormat(pattern).format(t.toLocal());
