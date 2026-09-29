import 'package:yyt_console/projects/limit_models.dart';
import 'package:flutter_test/flutter_test.dart';

LimitRow _row({
  String key = 'asset.fileBytes',
  String unit = 'bytes',
  int soft = 2 << 20,
  int? hard = 256 << 20,
  int? effective = 2 << 20,
  int? usage = 1000,
  int? step,
  int? next,
}) => LimitRow(
  key: key,
  unit: unit,
  soft: soft,
  hard: hard,
  effective: effective,
  usage: usage,
  step: step,
  next: next,
  override: null,
);

void main() {
  test(
    'formatLimit: binary units, counts with separators, days, unlimited',
    () {
      expect(formatLimit('bytes', 256 << 20), '256 MiB');
      expect(formatLimit('bytes', 3 << 30), '3 GiB');
      expect(formatLimit('bytes', (3 << 20) ~/ 2), '1.5 MiB');
      expect(formatLimit('bytes', 512), '512 B');
      expect(formatLimit('count', 100000), '100,000');
      expect(formatLimit('seconds', 28 * 86400), '28일');
      expect(formatLimit('seconds', null), '만료 없음');
      expect(formatLimit('count', null), '무제한');
    },
  );

  test('parseLimitInput reads sizes in binary units and plain counts', () {
    expect(parseLimitInput('bytes', '256MiB'), 256 << 20);
    expect(parseLimitInput('bytes', '3 GiB'), 3 << 30);
    expect(parseLimitInput('bytes', '1.5MiB'), (3 << 20) ~/ 2);
    expect(parseLimitInput('bytes', '4096'), 4096);
    expect(parseLimitInput('bytes', '1.3 B'), isNull);
    expect(parseLimitInput('count', '50,000'), 50000);
    expect(parseLimitInput('count', 'abc'), isNull);
  });

  test(
    'limitValueProblem mirrors the server: above effective, up to hard, next for a stepped key',
    () {
      expect(limitValueProblem(_row(), 64 << 20), isNull);
      expect(limitValueProblem(_row(), 2 << 20), contains('보다 커야'));
      expect(limitValueProblem(_row(), 1 << 30), contains('상한('));
      expect(limitValueProblem(_row(), null), contains('무제한으로 요청할 수 없습니다'));
      final lifetime = _row(
        key: 'channel.lifetime',
        unit: 'seconds',
        hard: null,
        effective: 28 * 86400,
        usage: null,
      );
      expect(limitValueProblem(lifetime, null), isNull);
      expect(limitValueProblem(lifetime, 30 * 86400), contains('"무제한"으로만'));
      final stepped = _row(
        key: 'team.projects',
        unit: 'count',
        soft: 20,
        hard: 1000,
        effective: 20,
        usage: 20,
        step: 5,
        next: 25,
      );
      expect(limitValueProblem(stepped, 25), isNull);
      expect(limitValueProblem(stepped, 30), contains('25'));
      final below = _row(
        key: 'team.projects',
        unit: 'count',
        soft: 20,
        hard: 1000,
        effective: 20,
        usage: 3,
        step: 5,
        next: null,
      );
      expect(limitValueProblem(below, 25), contains('모든 슬롯'));
      expect(below.canRequest, isFalse);
      expect(stepped.canRequest, isTrue);
    },
  );

  test('LimitsView parses rows, unlimited values and pending requests', () {
    final v = LimitsView.fromJson({
      'scope': {'kind': 'channel', 'id': 'auth_1'},
      'teamId': 'team_1',
      'expiresAt': 253402300799,
      'limits': [
        {
          'key': 'channel.lifetime',
          'unit': 'seconds',
          'soft': 2419200,
          'hard': 'unlimited',
          'effective': 'unlimited',
          'usage': null,
          'step': null,
          'next': null,
          'override': {
            'value': 'unlimited',
            'expiresAt': null,
            'note': 'contest',
            'requestId': null,
            'grantedBy': 'm_1',
            'grantedByLogin': 'boss',
            'grantedAt': 1700000000,
          },
        },
      ],
      'pending': [
        {
          'id': 'lr_1',
          'teamId': 'team_1',
          'scope': {'kind': 'channel', 'id': 'auth_1', 'name': 'game'},
          'key': 'channel.lifetime',
          'unit': 'seconds',
          'hard': 'unlimited',
          'requestedValue': 'unlimited',
          'reason': 'r',
          'status': 'pending',
          'createdBy': 'm_2',
          'createdByLogin': 'alice',
          'createdAt': 1700000000,
        },
      ],
    });
    expect(v.limits.single.hard, isNull);
    expect(v.limits.single.effective, isNull);
    expect(v.limits.single.override?.grantedByLogin, 'boss');
    expect(v.limits.single.atCeiling, isFalse);
    // Already unlimited: nothing more to ask for.
    expect(v.limits.single.canRequest, isFalse);
    expect(v.pending.single.requestedValue, isNull);
    expect(v.pending.single.scopeName, 'game');
    expect(v.pending.single.pending, isTrue);
  });
}
