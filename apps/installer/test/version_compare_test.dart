import 'package:catalog/app_install_state.dart';
import 'package:catalog/check_if_need_to_update.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('compareVersions', () {
    test('treats missing build suffix as the same release', () {
      expect(compareVersions('1.0.2', '1.0.2+4'), 0);
      expect(compareVersions('1.0.2+4', '1.0.2'), 0);
      expect(isSameVersion('1.0.2', '1.0.2+4'), isTrue);
      expect(
        resolveAppInstallState('1.0.2', '1.0.2+4'),
        AppInstallState.latest,
      );
      expect(
        resolveAppInstallState('1.0.2+4', '1.0.2'),
        AppInstallState.latest,
      );
    });

    test('compares build numbers when both versions include them', () {
      expect(compareVersions('1.0.2+4', '1.0.2+3'), greaterThan(0));
      expect(compareVersions('1.0.2+3', '1.0.2+4'), lessThan(0));
      expect(resolveAppInstallState('1.0.2+4', '1.0.2+3'), AppInstallState.old);
    });

    test('prioritizes the base semantic version over build number', () {
      expect(compareVersions('1.0.3', '1.0.2+99'), greaterThan(0));
      expect(compareVersions('1.0.1+9', '1.0.2+1'), lessThan(0));
    });

    test('falls back to update required when parsing fails', () {
      expect(checkIfNeedToUpdate('broken', '1.0.0'), isTrue);
      expect(isSameVersion('broken', '1.0.0'), isFalse);
    });
  });
}
