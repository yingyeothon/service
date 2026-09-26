/// Human-readable size in binary units; `정보 없음` for an unknown (≤ 0) size.
String formatBytes(int bytes) {
  if (bytes <= 0) {
    return '정보 없음';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  var value = bytes.toDouble();
  var unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  final digits = value >= 100 ? 0 : 1;
  return '${value.toStringAsFixed(digits)} ${units[unitIndex]}';
}
