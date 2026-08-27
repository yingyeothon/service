import 'package:yyt_console/projects/team_expansion_store.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('decodeTeamExpansion keeps only boolean entries', () {
    expect(decodeTeamExpansion('{"a":true,"b":false,"c":"x","d":1}'), {
      'a': true,
      'b': false,
    });
    expect(decodeTeamExpansion('[]'), isEmpty);
    expect(decodeTeamExpansion('not json'), isEmpty);
  });

  test('memory store round-trips a copy', () async {
    final store = MemoryTeamExpansionStore({'a': true});
    final read = await store.read();
    read['b'] = true;
    expect(await store.read(), {'a': true});
    await store.write(read);
    expect(await store.read(), {'a': true, 'b': true});
  });
}
