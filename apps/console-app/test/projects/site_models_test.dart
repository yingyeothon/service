import 'package:yyt_console/projects/site_models.dart';
import 'package:flutter_test/flutter_test.dart';

Site _site({String? description, String? domain}) => Site.fromJson({
  'id': 'st_1',
  'name': 'game',
  'slug': 'abcdefghi',
  'description': description,
  'publicUrl': 'https://g.example/abcdefghi/',
  'basePath': '/abcdefghi/',
  'currentDeployId': null,
  'busy': false,
  'createdAt': 1,
  'updatedAt': 1,
  'domain': domain,
});

void main() {
  test('domain grammar matrix', () {
    String? v(String s) => validateSiteDomain(normalizeSiteDomain(s));
    // Valid.
    for (final ok in [
      'abc',
      'my-game',
      'a1b',
      '123',
      'x' * 32,
      ' MyGame ', // trimmed and lower-cased first
      '', // blank releases the name
    ]) {
      expect(v(ok), isNull, reason: ok);
    }
    // Invalid.
    for (final bad in [
      'ab', // too short
      'x' * 33, // too long
      '-abc',
      'abc-',
      'a--b',
      'xn--abc',
      'a_b',
      'a.b',
      'a b',
      '한글이름',
    ]) {
      expect(v(bad), isNotNull, reason: bad);
    }
    expect(normalizeSiteDomain('  My-Game '), 'my-game');
  });

  test('site name hint follows the server grammar', () {
    expect(validateSiteName('game_1'), isNull);
    expect(validateSiteName(''), isNotNull);
    expect(validateSiteName('_game'), isNotNull);
    expect(validateSiteName('a.b'), isNotNull);
    expect(validateSiteName('st_game'), isNotNull);
    expect(validateSiteName('x' * 65), isNotNull);
  });

  test('buildSitePatch sends only the changed keys', () {
    final s = _site(description: 'about', domain: 'my-game');
    expect(
      buildSitePatch(
        s,
        name: ' game ',
        description: 'about',
        domain: 'MY-GAME',
      ),
      isEmpty,
    );
    expect(buildSitePatch(s, name: 'game2', description: 'about'), {
      'name': 'game2',
    });
    // A blank description or domain clears it.
    expect(buildSitePatch(s, name: 'game', description: ' ', domain: ''), {
      'description': null,
      'domain': null,
    });
    // Without a domain field the key never appears.
    expect(buildSitePatch(_site(), name: 'game', description: 'x'), {
      'description': 'x',
    });
    expect(
      buildSitePatch(_site(), name: 'game', description: '', domain: ' New1 '),
      {'domain': 'new1'},
    );
  });

  test('state and display url; absent new fields read as null', () {
    final s = _site();
    expect(s.domain, isNull);
    expect(s.hostUrl, isNull);
    expect(s.hostSuffix, isNull);
    expect(s.movingTo, isNull);
    expect(s.displayUrl, 'https://g.example/abcdefghi/');
    expect(s.state, SiteState.empty);
    final moving = Site.fromJson({
      'id': 'st_1',
      'publicUrl': 'https://g.example/abcdefghi/',
      'hostUrl': 'https://abcdefghi.g.example/',
      'busy': true,
      'movingTo': 'my-game',
      'currentDeployId': 'sd_1',
    });
    // Unnamed: the path URL is primary, the own host the other address.
    expect(moving.displayUrl, 'https://g.example/abcdefghi/');
    expect(moving.otherUrl, 'https://abcdefghi.g.example/');
    expect(moving.state, SiteState.moving);
    final named = Site.fromJson({
      'id': 'st_2',
      'slug': 'my-game',
      'domain': 'my-game',
      'publicUrl': 'https://g.example/my-game/',
      'hostUrl': 'https://my-game.g.example/',
    });
    expect(named.displayUrl, 'https://my-game.g.example/');
    expect(named.otherUrl, 'https://g.example/my-game/');
    expect(siteStateLabel(moving.state), '이동 중');
  });
}
