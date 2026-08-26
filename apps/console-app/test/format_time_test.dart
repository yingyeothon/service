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
}
