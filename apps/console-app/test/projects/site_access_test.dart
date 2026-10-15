import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/testing.dart';
import 'package:yyt_console/projects/projects_api.dart';
import 'package:yyt_console/projects/site_models.dart';
import 'package:yyt_console/projects/site_access_section.dart';
import 'widget_test_support.dart';

void main() {
  testWidgets(
    'unapproved site cannot configure auth; suspended site retains admin resume',
    (tester) async {
      Future<void> mount(bool approved, bool suspended) async {
        final api = ProjectsApi(
          token: 'fixture',
          baseUrl: 'https://console.example',
          client: MockClient(
            (r) async => r.url.path == '/me'
                ? jsonResponse({'role': 'admin'})
                : jsonResponse({
                    'scope': {'kind': 'site', 'id': 'st_1'},
                    'limits': [
                      {
                        'key': 'site.basicAuth',
                        'unit': 'count',
                        'soft': 0,
                        'hard': 1,
                        'effective': approved ? 1 : 0,
                        'usage': null,
                      },
                    ],
                    'pending': [],
                  }),
          ),
        );
        final site = Site.fromJson({
          'id': 'st_1',
          'name': 'preview',
          'slug': 'abc',
          'access': {
            'mode': 'basic',
            'username': 'viewer',
            'suspended': suspended,
            'sync': 'submitted',
            'available': true,
          },
        });
        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: SiteAccessSection(
                key: ValueKey('$approved-$suspended'),
                site: site,
                api: api,
                canWrite: true,
                reload: () async {},
                onUnauthorized: () async {},
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
      }

      await mount(false, false);
      expect(
        find.widgetWithText(OutlinedButton, 'Basic Auth 설정'),
        findsNothing,
      );
      await mount(true, true);
      expect(
        tester
            .widget<OutlinedButton>(
              find.widgetWithText(OutlinedButton, 'Basic Auth 설정'),
            )
            .onPressed,
        isNull,
      );
      expect(find.widgetWithText(OutlinedButton, '접근 재개'), findsOneWidget);
    },
  );
}
