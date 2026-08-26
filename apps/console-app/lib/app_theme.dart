import 'package:flutter/material.dart';

class CatalogPalette {
  static const ink = Color(0xFF0F2742);
  static const ocean = Color(0xFF1E5AA8);
  static const sky = Color(0xFFD8E8FF);
  static const glow = Color(0xFFFFB457);
  static const sunrise = Color(0xFFFFE2B8);
  static const mint = Color(0xFF0E9F8F);
  static const slate = Color(0xFF5D6C7F);
  static const cloud = Color(0xFFF4F7FB);
  static const shell = Color(0xFFFFFFFF);
  static const debugSurface = Color(0xFFFFF6DE);
  static const debugBorder = Color(0xFFF2DCA0);
  static const debugAccent = Color(0xFFFFE2A6);
  static const releaseSurface = Color(0xFFEFF5FF);
  static const releaseBorder = Color(0xFFD5E2FF);
  static const releaseAccent = Color(0xFFD8E8FF);
}

ThemeData buildCatalogTheme() {
  final scheme = ColorScheme.fromSeed(
    seedColor: CatalogPalette.ocean,
    brightness: Brightness.light,
  ).copyWith(
    primary: CatalogPalette.ocean,
    secondary: CatalogPalette.glow,
    tertiary: CatalogPalette.mint,
    surface: CatalogPalette.shell,
    surfaceContainerHighest: const Color(0xFFE7EEF7),
    onSurface: CatalogPalette.ink,
    outline: const Color(0xFFB6C4D6),
  );

  final base = ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: CatalogPalette.cloud,
  );

  return base.copyWith(
    appBarTheme: const AppBarTheme(
      backgroundColor: Colors.transparent,
      foregroundColor: CatalogPalette.ink,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: false,
    ),
    cardTheme: CardThemeData(
      color: CatalogPalette.shell,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(22)),
    ),
    chipTheme: base.chipTheme.copyWith(
      backgroundColor: const Color(0xFFECF3FD),
      selectedColor: const Color(0xFFD8E8FF),
      side: BorderSide.none,
      labelStyle: const TextStyle(
        color: CatalogPalette.ink,
        fontWeight: FontWeight.w600,
      ),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
    ),
    dividerTheme: const DividerThemeData(
      color: Color(0xFFDCE4EF),
      thickness: 1,
      space: 1,
    ),
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        elevation: 0,
        backgroundColor: CatalogPalette.ink,
        foregroundColor: Colors.white,
        disabledBackgroundColor: const Color(0xFFDDE6F2),
        disabledForegroundColor: CatalogPalette.slate,
        minimumSize: const Size(0, 42),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        textStyle: const TextStyle(fontWeight: FontWeight.w700),
      ),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: CatalogPalette.ocean,
        foregroundColor: Colors.white,
        minimumSize: const Size(0, 42),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        textStyle: const TextStyle(fontWeight: FontWeight.w700),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: Colors.white,
      hintStyle: const TextStyle(color: CatalogPalette.slate),
      prefixIconColor: CatalogPalette.slate,
      suffixIconColor: CatalogPalette.slate,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(18),
        borderSide: BorderSide.none,
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(18),
        borderSide: const BorderSide(color: Color(0xFFDDE6F2)),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(18),
        borderSide: const BorderSide(color: CatalogPalette.ocean, width: 1.4),
      ),
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
    ),
    progressIndicatorTheme: const ProgressIndicatorThemeData(
      color: CatalogPalette.ocean,
      linearTrackColor: Color(0xFFDCE7F6),
    ),
    snackBarTheme: const SnackBarThemeData(behavior: SnackBarBehavior.floating),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        foregroundColor: CatalogPalette.ocean,
        textStyle: const TextStyle(fontWeight: FontWeight.w700),
      ),
    ),
    textTheme: base.textTheme.copyWith(
      headlineMedium: base.textTheme.headlineMedium?.copyWith(
        color: CatalogPalette.ink,
        fontWeight: FontWeight.w800,
        letterSpacing: -0.6,
      ),
      headlineSmall: base.textTheme.headlineSmall?.copyWith(
        color: CatalogPalette.ink,
        fontWeight: FontWeight.w800,
        letterSpacing: -0.4,
      ),
      titleLarge: base.textTheme.titleLarge?.copyWith(
        color: CatalogPalette.ink,
        fontWeight: FontWeight.w800,
        letterSpacing: -0.2,
      ),
      titleMedium: base.textTheme.titleMedium?.copyWith(
        color: CatalogPalette.ink,
        fontWeight: FontWeight.w700,
      ),
      bodyLarge: base.textTheme.bodyLarge?.copyWith(
        color: CatalogPalette.ink,
        height: 1.35,
      ),
      bodyMedium: base.textTheme.bodyMedium?.copyWith(
        color: CatalogPalette.slate,
        height: 1.4,
      ),
      labelLarge: base.textTheme.labelLarge?.copyWith(
        fontWeight: FontWeight.w700,
      ),
    ),
  );
}
