/// Local advice only; a grade never decides whether a password may be saved.
String sitePasswordStrength(String value) {
  final length = value.runes.length;
  final distinct = value.runes.toSet().length;
  final lower = value.toLowerCase().trim();
  final common = RegExp(
    r'^(password|qwerty|admin|welcome|letmein|test|abcd|iloveyou)[\d\W_]*$',
    caseSensitive: false,
  ).hasMatch(lower);
  final repeated = RegExp(r'^(.{1,4})\1+$', unicode: true).hasMatch(lower);
  final sequence =
      [
        '01234567890123456789',
        'abcdefghijklmnopqrstuvwxyz',
        'qwertyuiopasdfghjklzxcvbnm',
      ].any(
        (s) => s.contains(lower) || s.split('').reversed.join().contains(lower),
      );
  if (length < 8 || distinct <= 2 || common || repeated || sequence) {
    return 'Too easy';
  }
  final classes = [
    r'[a-z]',
    r'[A-Z]',
    r'[0-9]',
    r'[^a-zA-Z0-9\s\u0080-\uFFFF]',
    r'[^\x00-\x7f]',
  ].where((p) => RegExp(p).hasMatch(value)).length;
  if (distinct >= 8 && (length >= 16 || (length >= 12 && classes >= 3))) {
    return 'Strong';
  }
  return 'Medium';
}

String? sitePasswordIssue(String value) {
  final length = value.runes.length;
  if (length < 4) return '4글자 이상 입력하세요.';
  if (length > 128) return '128글자 이하로 입력하세요.';
  if (value.runes.any(
    (c) => c < 32 || (c >= 127 && c <= 159) || (c >= 0xd800 && c <= 0xdfff),
  )) {
    return '제어 문자는 사용할 수 없습니다.';
  }
  return null;
}
