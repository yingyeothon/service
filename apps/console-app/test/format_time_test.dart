import 'package:yyt_console/format_time.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/intl.dart';

void main() {
  test('server UTC timestamps render in the device time zone', () {
    final utc = DateTime.utc(2026, 8, 27, 0, 30);
    final expected = DateFormat('yyyy.MM.dd HH:mm').format(utc.toLocal());
    expect(formatLocalTime(utc), expected);
    // Same instant, already local: identical output.
    expect(formatLocalTime(utc.toLocal()), expected);
  });

  test('formatRelative rounds like the web console', () {
    final now = DateTime.utc(2026, 9, 1, 12);
    String rel(Duration d) => formatRelative(now.add(d), now: now);
    expect(rel(const Duration(days: 7)), '7일 후');
    expect(rel(const Duration(days: 6, hours: 13)), '7일 후');
    expect(rel(const Duration(hours: 23)), '23시간 후');
    expect(rel(const Duration(minutes: 90)), '2시간 후');
    expect(rel(const Duration(minutes: 5)), '5분 후');
    expect(rel(const Duration(seconds: 10)), '1분 후');
    expect(rel(Duration.zero), '1분 후');
    expect(rel(const Duration(seconds: -10)), '1분 전');
    expect(rel(const Duration(hours: -3)), '3시간 전');
    expect(rel(const Duration(days: -2)), '2일 전');
  });

  test('the no-expiry sentinel is recognised, a real date is not', () {
    expect(
      isNoExpiry(
        DateTime.fromMillisecondsSinceEpoch(
          channelNoExpirySec * 1000,
          isUtc: true,
        ),
      ),
      isTrue,
    );
    expect(isNoExpiry(DateTime.utc(2100)), isFalse);
  });
}
