import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:yyt_console/projects/resource_widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/testing.dart';
import 'package:yyt_console/projects/projects_api.dart';
import 'package:yyt_console/projects/site_models.dart';
import 'package:yyt_console/projects/site_access_section.dart';
import 'widget_test_support.dart';

void main() {
  testWidgets(
    'grades update below the field and a weak four-character value can be saved',
    (tester) async {
      Map<String, dynamic>? sent;
      final api = ProjectsApi(
        token: 'fixture',
        baseUrl: 'https://console.example',
        client: MockClient((r) async {
          if (r.method == 'PUT') {
            sent = jsonDecode(r.body) as Map<String, dynamic>;
            return jsonResponse({});
          }
          return r.url.path == '/me'
              ? jsonResponse({'role': 'member'})
              : jsonResponse({
                  'scope': {'kind': 'site', 'id': 'st_1'},
                  'limits': [
                    {
                      'key': 'site.basicAuth',
                      'unit': 'count',
                      'soft': 0,
                      'hard': 1,
                      'effective': 1,
                      'usage': null,
                    },
                  ],
                  'pending': [],
                });
        }),
      );
      final site = Site.fromJson({
        'id': 'st_1',
        'name': 'preview',
        'slug': 'abc',
        'access': {
          'mode': 'public',
          'username': null,
          'suspended': false,
          'sync': 'submitted',
          'available': true,
        },
      });
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SiteAccessSection(
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
      await tester.tap(find.widgetWithText(OutlinedButton, 'Basic Auth 설정'));
      await tester.pumpAndSettle();
      final fields = find.byType(TextFormField);
      await tester.enterText(fields.at(0), 'viewer');
      await tester.enterText(fields.at(1), '123');
      await tester.tap(find.text('저장'));
      await tester.pumpAndSettle();
      expect(sent, isNull);
      expect(find.text('4글자 이상 입력하세요.'), findsOneWidget);
      for (final item in [
        ('1234', 'Too easy', ChipTone.danger),
        ('cedarFox', 'Medium', ChipTone.warn),
        ('Mango!River83', 'Strong', ChipTone.ok),
      ]) {
        await tester.enterText(fields.at(1), item.$1);
        await tester.pumpAndSettle();
        expect(find.text(item.$2), findsOneWidget);
        expect(
          tester.widget<StatusChip>(find.byType(StatusChip)).tone,
          item.$3,
        );
      }
      await tester.enterText(fields.at(1), '1234');
      await tester.tap(find.text('저장'));
      await tester.pumpAndSettle();
      expect(sent, {'mode': 'basic', 'username': 'viewer', 'password': '1234'});
    },
  );
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
