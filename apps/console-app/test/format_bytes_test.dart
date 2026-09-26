import 'package:yyt_console/format_bytes.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  // Pins the formatter app_cards used before it moved to its own file.
  test('formatBytes keeps the catalog card output', () {
    expect(formatBytes(0), '정보 없음');
    expect(formatBytes(-5), '정보 없음');
    expect(formatBytes(1), '1.0 B');
    expect(formatBytes(99), '99.0 B');
    expect(formatBytes(100), '100 B');
    expect(formatBytes(1023), '1023 B');
    expect(formatBytes(1024), '1.0 KB');
    expect(formatBytes(1200), '1.2 KB');
    expect(formatBytes(150 * 1024), '150 KB');
    expect(formatBytes(5 * 1024 * 1024), '5.0 MB');
    expect(formatBytes(3 * 1024 * 1024 * 1024), '3.0 GB');
    expect(formatBytes(2048 * 1024 * 1024 * 1024), '2048 GB');
  });
}
