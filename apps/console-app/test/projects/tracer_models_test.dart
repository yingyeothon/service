import 'package:yyt_console/projects/limit_models.dart';
import 'package:yyt_console/projects/site_models.dart';
import 'package:yyt_console/projects/tracer_models.dart';
import 'package:flutter_test/flutter_test.dart';

const _id = 'trc_01hf7yavygfgdxpjfmr5r0g6ca';

void main() {
  test('reads the member view, the seatless-admin list row and a null DSN', () {
    final member = Tracer.fromJson({
      'id': _id,
      'name': 'game-debug',
      'description': 'debug builds',
      'writeKey': 'k' * 32,
      'dsn': 'https://${'k' * 32}@trace.example/$_id',
      'readUrl': 'https://trace.example',
      'noBackup': true,
      'teamId': 'team_1',
      'createdBy': 'alice',
      'createdAt': 1700000000,
      'updatedAt': 1700000000,
    });
    expect(member.writeKey, 'k' * 32);
    expect(member.dsn, endsWith('/$_id'));
    expect(member.description, 'debug builds');
    expect(member.createdAt.isUtc, isTrue);
    expect(member.readCommands.first, 'yyt tracer issues $_id --since 1h');
    expect(member.limitRequestCommand, contains('--tracer $_id'));

    final admin = Tracer.fromJson({
      'id': _id,
      'name': 'game-debug',
      'readUrl': null,
      'noBackup': true,
      'createdAt': 1700000000,
      'updatedAt': 1700000000,
    });
    expect(admin.writeKey, isNull);
    expect(admin.dsn, isNull);
    expect(admin.readUrl, isNull);
    expect(admin.description, isNull);
  });

  test('names follow the server grammar, ids included', () {
    expect(validateTracerName('my.game-debug_1'), isNull);
    expect(validateTracerName(''), isNotNull);
    expect(validateTracerName('-bad'), isNotNull);
    expect(validateTracerName('has space'), isNotNull);
    expect(validateTracerName('a' * 65), isNotNull);
    expect(validateTracerName('trc_x'), contains('id처럼'));
    expect(validateTracerName('TRC_x'), contains('id처럼'));
    expect(validateTracerName('push_x'), contains('id처럼'));
    // The site validator shares the id list.
    expect(validateSiteName('trc_x'), contains('id처럼'));
  });

  test(
    'a patch carries only the changed keys; a blank description is null',
    () {
      final t = Tracer.fromJson({
        'id': _id,
        'name': 'game-debug',
        'description': 'old',
        'createdAt': 0,
        'updatedAt': 0,
      });
      expect(buildTracerPatch(t, name: ' game-debug ', description: 'old'), {});
      expect(buildTracerPatch(t, name: 'renamed', description: 'old'), {
        'name': 'renamed',
      });
      expect(buildTracerPatch(t, name: 'game-debug', description: '  '), {
        'description': null,
      });
    },
  );

  test('a byte step waits on usage, not slots, and reads in units', () {
    const mib = 1024 * 1024;
    final row = LimitRow.fromJson({
      'key': 'tracer.dailyBytes',
      'unit': 'bytes',
      'soft': 50 * mib,
      'hard': 300 * mib,
      'effective': 50 * mib,
      'usage': 10 * mib,
      'step': 50 * mib,
      'next': null,
    });
    expect(steppedWaitHint(row), contains('50 MiB'));
    expect(limitValueProblem(row, 100 * mib), isNot(contains('슬롯')));
  });

  test('labels the tracer limit keys', () {
    expect(limitLabel('tracer.dailyBytes'), '하루 디버그 데이터');
    expect(limitLabel('tracer.resources'), '트레이서 리소스 수');
  });
}
