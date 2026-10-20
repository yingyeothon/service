import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:yyt_console/catalog_platform.dart';
import 'package:yyt_console/catalog_platform_selector.dart';

void main() {
  test('the default filter is the device platform', () {
    addTearDown(() => debugDefaultTargetPlatformOverride = null);
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    expect(deviceCatalogPlatform(), CatalogPlatform.ios);
    expect(isIosDevice(), isTrue);
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    expect(deviceCatalogPlatform(), CatalogPlatform.android);
    expect(isIosDevice(), isFalse);
    // Anything else is treated like Android, the app's original platform.
    debugDefaultTargetPlatformOverride = TargetPlatform.linux;
    expect(deviceCatalogPlatform(), CatalogPlatform.android);
  });

  test('query omits the parameter for all; matches is case-insensitive', () {
    expect(CatalogPlatform.ios.query, 'ios');
    expect(CatalogPlatform.android.query, 'android');
    expect(CatalogPlatform.all.query, isNull);
    expect(CatalogPlatform.ios.matches('iOS'), isTrue);
    expect(CatalogPlatform.ios.matches('android'), isFalse);
    expect(CatalogPlatform.android.matches('bin'), isFalse);
    for (final p in ['ios', 'android', 'bin', 'server', 'windows', '']) {
      expect(CatalogPlatform.all.matches(p), isTrue);
    }
  });

  test('parse reads back what the store writes and nothing else', () {
    for (final p in CatalogPlatform.values) {
      expect(CatalogPlatform.parse(p.name), p);
    }
    expect(CatalogPlatform.parse('bin'), isNull);
    expect(CatalogPlatform.parse(null), isNull);
  });

  testWidgets('the selector sets the shared notifier', (tester) async {
    final platform = ValueNotifier(CatalogPlatform.android);
    addTearDown(platform.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: CatalogPlatformSelector(platform: platform)),
      ),
    );
    expect(find.text('iOS'), findsOneWidget);
    expect(find.text('Android'), findsOneWidget);
    expect(find.text('전체'), findsOneWidget);
    await tester.tap(find.text('전체'));
    await tester.pump();
    expect(platform.value, CatalogPlatform.all);
    await tester.tap(find.text('iOS'));
    await tester.pump();
    expect(platform.value, CatalogPlatform.ios);
  });

  test('empty-state titles name the platform', () {
    expect(noAppsTitle(CatalogPlatform.ios), '설치 가능한 iOS 앱이 없습니다');
    expect(noAppsTitle(CatalogPlatform.all), '설치 가능한 앱이 없습니다');
    expect(noListingsTitle(CatalogPlatform.android), '게시된 Android 앱이 없습니다');
  });
}
