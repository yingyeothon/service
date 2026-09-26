import 'package:yyt_console/projects/channel_config_form.dart';
import 'package:flutter_test/flutter_test.dart';

Matcher _formError(String part) => throwsA(
  isA<ChannelFormError>().having((e) => e.message, 'message', contains(part)),
);

void main() {
  group('create', () {
    test('auth: trimmed fields, allowlist lines, providers with secrets', () {
      final f =
          ChannelFormState()
            ..audience = ' my-game '
            ..tokenTtlSec = '3600'
            ..redirectAllowlist =
                'https://a.example/cb\r\n\n  http://localhost:3000/cb '
            ..githubEnabled = true
            ..githubClientId = ' gh-id '
            ..githubSecretInput = ' gh-secret ';
      expect(buildChannelConfig('auth', f), {
        'audience': 'my-game',
        'tokenTtlSec': 3600,
        'redirectAllowlist': [
          'https://a.example/cb',
          'http://localhost:3000/cb',
        ],
        'providers': {
          'github': {'clientId': 'gh-id', 'clientSecret': 'gh-secret'},
        },
      });
    });

    test('auth: defaults, and a provider needs both id and secret', () {
      final f = ChannelFormState()..audience = 'a';
      expect(buildChannelConfig('auth', f), {
        'audience': 'a',
        'tokenTtlSec': 86400,
        'redirectAllowlist': <String>[],
        'providers': <String, dynamic>{},
      });
      f.googleEnabled = true;
      expect(
        () => buildChannelConfig('auth', f),
        _formError('Google 클라이언트 ID'),
      );
      f.googleClientId = 'id';
      expect(
        () => buildChannelConfig('auth', f),
        _formError('Google 클라이언트 시크릿'),
      );
      expect(
        () => buildChannelConfig('auth', ChannelFormState()),
        _formError('오디언스'),
      );
      expect(
        () => buildChannelConfig(
          'auth',
          ChannelFormState()
            ..audience = 'a'
            ..tokenTtlSec = '',
        ),
        _formError('토큰 TTL: 정수'),
      );
      expect(
        () => buildChannelConfig(
          'auth',
          ChannelFormState()
            ..audience = 'a'
            ..tokenTtlSec = '${30 * 86400 + 1}',
        ),
        _formError('1~2592000'),
      );
    });

    test('topic and q carry only the auth link, which is required', () {
      final f = ChannelFormState()..authChannelId = 'auth_1';
      expect(buildChannelConfig('topic', f), {'authChannelId': 'auth_1'});
      expect(buildChannelConfig('q', f), {'authChannelId': 'auth_1'});
      expect(
        () => buildChannelConfig('q', ChannelFormState()),
        _formError('인증 채널'),
      );
    });

    test('match: numbers, and a blank callback leaves the key out', () {
      final f =
          ChannelFormState()
            ..authChannelId = 'auth_1'
            ..partySize = '4'
            ..waitTimeoutSec = '30'
            ..onTimeout = 'partial'
            ..callbackUrl = '  ';
      expect(buildChannelConfig('match', f), {
        'authChannelId': 'auth_1',
        'partySize': 4,
        'waitTimeoutSec': 30,
        'onTimeout': 'partial',
      });
      f.callbackUrl = ' https://game.example/match ';
      expect(
        buildChannelConfig('match', f)['callbackUrl'],
        'https://game.example/match',
      );
      f.partySize = '2.5';
      expect(() => buildChannelConfig('match', f), _formError('파티 크기: 정수'));
      f
        ..partySize = '17'
        ..callbackUrl = '';
      expect(() => buildChannelConfig('match', f), _formError('2~16'));
      f
        ..partySize = '2'
        ..callbackUrl = 'not a url';
      expect(() => buildChannelConfig('match', f), _formError('콜백 URL'));
    });

    test('lobby: defaults build the SPA payload', () {
      final f = ChannelFormState()..authChannelId = 'auth_1';
      expect(buildChannelConfig('lobby', f), {
        'authChannelId': 'auth_1',
        'capabilities': {
          'pos': true,
          'say': ['zone'],
          'party': true,
          'event': true,
          'debug': false,
        },
        'flushIntervalMs': 200,
        'maxMoveDelta': 4,
        'rateLimit': 30,
        'partySizeMax': 4,
        'defaultZone': 'lobby',
        'mapUrl': '',
        'maxPeers': 64,
      });
    });

    test('lobby: chat scopes in canonical order, aoi only when set', () {
      final f =
          ChannelFormState()
            ..authChannelId = 'auth_1'
            ..capSay = ['user', 'zone', 'party']
            ..aoiRange = ' 12 '
            ..mapUrl = ' https://d.example/map.json ';
      final c = buildChannelConfig('lobby', f);
      expect((c['capabilities'] as Map)['say'], ['zone', 'party', 'user']);
      expect(c['aoi'], {'range': 12});
      expect(c['mapUrl'], 'https://d.example/map.json');
      f.aoiRange = '';
      expect(buildChannelConfig('lobby', f).containsKey('aoi'), isFalse);
    });

    test('lobby: the cross-checks the API also makes', () {
      ChannelFormState base() => ChannelFormState()..authChannelId = 'auth_1';
      expect(
        () => buildChannelConfig(
          'lobby',
          base()
            ..capSay = ['party']
            ..capParty = false,
        ),
        _formError('"party"'),
      );
      expect(
        () => buildChannelConfig('lobby', base()..capPos = false),
        _formError('"zone"'),
      );
      expect(
        () => buildChannelConfig(
          'lobby',
          base()
            ..capPos = false
            ..capSay = []
            ..aoiRange = '5',
        ),
        _formError('시야 범위는 위치'),
      );
      expect(
        () =>
            buildChannelConfig('lobby', base()..mapUrl = 'http://d.example/m'),
        _formError('https'),
      );
      expect(
        () => buildChannelConfig('lobby', base()..defaultZone = ' '),
        _formError('시작 존'),
      );
      expect(
        () => buildChannelConfig('lobby', base()..flushIntervalMs = '49'),
        _formError('50~2000'),
      );
      // Positions off with no zone chat and no view range is fine.
      expect(
        (buildChannelConfig(
              'lobby',
              base()
                ..capPos = false
                ..capSay = [],
            )['capabilities']
            as Map)['pos'],
        isFalse,
      );
    });
  });

  group('edit', () {
    const authConfig = {
      'audience': 'game',
      'tokenTtlSec': 86400,
      'redirectAllowlist': ['https://a.example/cb'],
      'providers': {
        'github': {'clientId': 'gh-id'},
      },
    };

    ChannelFormState authForm() => ChannelFormState.fromChannel(
      kind: 'auth',
      name: 'login',
      config: authConfig,
    );

    test('fromChannel pre-fills auth without secrets', () {
      final f = authForm();
      expect(f.name, 'login');
      expect(f.audience, 'game');
      expect(f.tokenTtlSec, '86400');
      expect(f.redirectAllowlist, 'https://a.example/cb');
      expect(f.githubEnabled, isTrue);
      expect(f.githubClientId, 'gh-id');
      expect(f.githubSecretInput, '');
      expect(f.googleEnabled, isFalse);
    });

    test(
      'auth patch: a kept provider with a blank secret sends no secret key',
      () {
        final c = buildChannelConfig(
          'auth',
          authForm(),
          patch: true,
          existingConfig: authConfig,
        );
        final github = (c['providers'] as Map)['github'] as Map;
        expect(github, {'clientId': 'gh-id'});
        expect(github.containsKey('clientSecret'), isFalse);
        expect((c['providers'] as Map).containsKey('google'), isFalse);
      },
    );

    test('auth patch: a typed secret on a kept provider replaces it', () {
      final f = authForm()..githubSecretInput = 'new-secret';
      final c = buildChannelConfig(
        'auth',
        f,
        patch: true,
        existingConfig: authConfig,
      );
      expect((c['providers'] as Map)['github'], {
        'clientId': 'gh-id',
        'clientSecret': 'new-secret',
      });
    });

    test('auth patch: a newly enabled provider needs its secret', () {
      final f =
          authForm()
            ..googleEnabled = true
            ..googleClientId = 'g-id';
      expect(
        () => buildChannelConfig(
          'auth',
          f,
          patch: true,
          existingConfig: authConfig,
        ),
        _formError('Google 클라이언트 시크릿'),
      );
      f.googleSecretInput = 'g-secret';
      expect(
        (buildChannelConfig(
              'auth',
              f,
              patch: true,
              existingConfig: authConfig,
            )['providers']
            as Map)['google'],
        {'clientId': 'g-id', 'clientSecret': 'g-secret'},
      );
    });

    test('auth patch: a stored provider switched off sends null', () {
      final f = authForm()..githubEnabled = false;
      final providers =
          buildChannelConfig(
                'auth',
                f,
                patch: true,
                existingConfig: authConfig,
              )['providers']
              as Map;
      expect(providers.containsKey('github'), isTrue);
      expect(providers['github'], isNull);
      // On create an unchecked provider is simply absent.
      expect(
        (buildChannelConfig('auth', f)['providers'] as Map).containsKey(
          'github',
        ),
        isFalse,
      );
    });

    test('match: a cleared callback is omitted from the full replace', () {
      const stored = {
        'authChannelId': 'auth_1',
        'partySize': 2,
        'waitTimeoutSec': 60,
        'onTimeout': 'fail',
        'callbackUrl': 'https://game.example/match',
      };
      final initial = ChannelFormState.fromChannel(
        kind: 'match',
        name: 'mm',
        config: stored,
      );
      expect(initial.callbackUrl, 'https://game.example/match');
      final form = initial.copy()..callbackUrl = '';
      final body = buildChannelEdit(
        'match',
        storedName: 'mm',
        storedConfig: stored,
        initial: initial,
        form: form,
      );
      expect(body.containsKey('name'), isFalse);
      expect(body['config'], {
        'authChannelId': 'auth_1',
        'partySize': 2,
        'waitTimeoutSec': 60,
        'onTimeout': 'fail',
      });
    });

    test('lobby: a legacy aoi.maxPeers folds into maxPeers; a cleared aoi '
        'and unknown stored keys are not echoed', () {
      const stored = {
        'authChannelId': 'auth_1',
        'capabilities': {
          'pos': true,
          'say': ['zone'],
          'party': true,
          'event': true,
          'debug': false,
        },
        'flushIntervalMs': 200,
        'maxMoveDelta': 4,
        'rateLimit': 30,
        'partySizeMax': 4,
        'defaultZone': 'town',
        'mapUrl': 'https://d.example/map.json',
        'aoi': {'range': 8, 'maxPeers': 32},
        'legacyKnob': true,
      };
      final initial = ChannelFormState.fromChannel(
        kind: 'lobby',
        name: 'world',
        config: stored,
      );
      expect(initial.maxPeers, '32');
      expect(initial.aoiRange, '8');
      expect(initial.defaultZone, 'town');
      final form = initial.copy()..aoiRange = '';
      final body = buildChannelEdit(
        'lobby',
        storedName: 'world',
        storedConfig: stored,
        initial: initial,
        form: form,
      );
      final config = body['config'] as Map;
      expect(config.containsKey('aoi'), isFalse);
      expect(config.containsKey('legacyKnob'), isFalse);
      expect(config['maxPeers'], 32);
    });

    test('name only when changed, config only when a config field changed', () {
      final initial = authForm();
      expect(
        buildChannelEdit(
          'auth',
          storedName: 'login',
          storedConfig: authConfig,
          initial: initial,
          form: initial.copy()..name = ' login ',
        ),
        isEmpty,
      );
      expect(
        buildChannelEdit(
          'auth',
          storedName: 'login',
          storedConfig: authConfig,
          initial: initial,
          form: initial.copy()..name = 'login2',
        ),
        {'name': 'login2'},
      );
      final typedSecretEdit = buildChannelEdit(
        'auth',
        storedName: 'login',
        storedConfig: authConfig,
        initial: initial,
        form: initial.copy()..githubSecretInput = 's',
      );
      expect(typedSecretEdit.keys, ['config']);
      // Chat scopes compare as a set in canonical order.
      final lobby = ChannelFormState()..capSay = ['party', 'zone'];
      expect(
        lobby.sameConfigAs(lobby.copy()..capSay = ['zone', 'party']),
        isTrue,
      );
    });
  });
}
