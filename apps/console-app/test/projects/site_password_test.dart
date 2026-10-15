import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:yyt_console/projects/site_password.dart';

void main() {
  test(
    'shared guidance fixtures agree with the web and permit weak passwords',
    () {
      final cases =
          jsonDecode(
                File(
                  '../../test/fixtures/site-passwords.json',
                ).readAsStringSync(),
              )
              as List;
      for (final row in cases) {
        final value = row['input'] as String;
        expect(sitePasswordStrength(value), row['grade']);
        expect(sitePasswordIssue(value) == null, row['valid']);
      }
    },
  );
  test('Unicode boundaries count code points', () {
    expect(sitePasswordIssue(List.filled(128, '🔑').join()), isNull);
    expect(sitePasswordIssue(List.filled(129, '🔑').join()), isNotNull);
    expect(sitePasswordIssue('🔑🔑🔑'), isNotNull);
  });
}
