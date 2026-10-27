import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:yyt_console/share/share_route.dart';

Route<void> _page(String text, {String? name}) => MaterialPageRoute<void>(
  settings: RouteSettings(name: name),
  builder: (_) => Scaffold(body: Text(text)),
);

void main() {
  final key = GlobalKey<NavigatorState>();
  late RouteStackObserver observer;

  Future<void> pump(WidgetTester tester) async {
    observer = RouteStackObserver();
    await tester.pumpWidget(
      MaterialApp(
        navigatorKey: key,
        navigatorObservers: [observer],
        home: const Scaffold(body: Text('root')),
      ),
    );
  }

  testWidgets('a profile change keeps the share screen and its dialog', (
    tester,
  ) async {
    await pump(tester);
    key.currentState!.push(_page('detail'));
    await tester.pumpAndSettle();
    key.currentState!.push(_page('share', name: sharedAppRouteName));
    await tester.pumpAndSettle();
    key.currentState!.push(_page('dialog'));
    await tester.pumpAndSettle();
    expect(observer.routes, hasLength(4));

    popToRootKeepingShares(key.currentState!, observer.routes);
    await tester.pumpAndSettle();

    expect(observer.routes, hasLength(3));
    expect(find.text('dialog'), findsOneWidget);
    key.currentState!.pop();
    await tester.pumpAndSettle();
    expect(find.text('share'), findsOneWidget);
    key.currentState!.pop();
    await tester.pumpAndSettle();
    // The previous profile's detail screen is gone.
    expect(find.text('root'), findsOneWidget);
    expect(observer.routes, hasLength(1));
  });

  testWidgets('without a share screen it pops to the root', (tester) async {
    await pump(tester);
    key.currentState!.push(_page('detail'));
    key.currentState!.push(_page('issue'));
    await tester.pumpAndSettle();

    popToRootKeepingShares(key.currentState!, observer.routes);
    await tester.pumpAndSettle();

    expect(find.text('root'), findsOneWidget);
    expect(observer.routes, hasLength(1));
  });
}
