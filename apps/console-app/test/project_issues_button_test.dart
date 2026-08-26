import 'package:yyt_console/app_home.dart';
import 'package:yyt_console/projects/models.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('AppHome comes from the breadcrumb and is absent without it', () {
    expect(AppHome.fromAppJson({'id': 'ca_1'}), isNull);
    final home =
        AppHome.fromAppJson({
          'teamId': 'team_1',
          'teamName': 'dooroo',
          'teamRole': 'member',
          'projectId': 'prj_1',
          'projectName': 'advent_cal',
        })!;
    expect(home.team, isA<Team>().having((t) => t.canWrite, 'canWrite', true));
    expect(
      home.project,
      isA<Project>().having((p) => p.teamId, 'teamId', 'team_1'),
    );
  });
}
