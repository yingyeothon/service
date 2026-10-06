import 'package:yyt_console/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// Small building blocks shared by the site and channel screens.

enum ChipTone { ok, warn, danger, neutral, accent }

class StatusChip extends StatelessWidget {
  const StatusChip({
    super.key,
    required this.label,
    this.tone = ChipTone.neutral,
  });

  final String label;
  final ChipTone tone;

  @override
  Widget build(BuildContext context) {
    final (bg, fg) = switch (tone) {
      ChipTone.ok => (const Color(0xFFDDF4EF), const Color(0xFF0B6E63)),
      ChipTone.warn => (CatalogPalette.sunrise, const Color(0xFF8A5300)),
      ChipTone.danger => (const Color(0xFFFFE0DE), const Color(0xFFA3261B)),
      ChipTone.accent => (CatalogPalette.sky, CatalogPalette.ocean),
      ChipTone.neutral => (const Color(0xFFECEFF3), CatalogPalette.slate),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        maxLines: 1,
        style: Theme.of(context).textTheme.labelSmall?.copyWith(
          color: fg,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

/// A labelled value with a copy button; the value wraps so a URL is read
/// in full.
class CopyRow extends StatelessWidget {
  const CopyRow({super.key, required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  label,
                  style: Theme.of(
                    context,
                  ).textTheme.bodySmall?.copyWith(color: CatalogPalette.slate),
                ),
                const SizedBox(height: 2),
                Text(value.isEmpty ? '—' : value),
              ],
            ),
          ),
          if (value.isNotEmpty)
            IconButton(
              tooltip: '$label 복사',
              icon: const Icon(Icons.copy_rounded, size: 20),
              onPressed: () => copyWithNotice(context, label, value),
            ),
        ],
      ),
    );
  }
}

Future<void> copyWithNotice(
  BuildContext context,
  String label,
  String value,
) async {
  await Clipboard.setData(ClipboardData(text: value));
  if (!context.mounted) return;
  ScaffoldMessenger.of(
    context,
  ).showSnackBar(SnackBar(content: Text('$label 복사했습니다.')));
}

/// A titled card section.
class SectionCard extends StatelessWidget {
  const SectionCard({super.key, required this.title, required this.children});

  final String title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 8, 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: 6),
            ...children,
          ],
        ),
      ),
    );
  }
}

/// Muted explanatory text.
class HintText extends StatelessWidget {
  const HintText(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Text(
        text,
        style: Theme.of(
          context,
        ).textTheme.bodySmall?.copyWith(color: CatalogPalette.slate),
      ),
    );
  }
}

/// A tinted notice (warning, in-flight state, read-only).
class NoticeCard extends StatelessWidget {
  const NoticeCard({
    super.key,
    required this.text,
    this.icon = Icons.info_outline_rounded,
    this.tone = ChipTone.warn,
    this.action,
  });

  final String text;
  final IconData icon;
  final ChipTone tone;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final bg = switch (tone) {
      ChipTone.warn => const Color(0xFFFFF4E0),
      ChipTone.danger => const Color(0xFFFFECEA),
      ChipTone.accent => CatalogPalette.releaseSurface,
      _ => const Color(0xFFF1F4F8),
    };
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 20, color: CatalogPalette.ink),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(text, style: Theme.of(context).textTheme.bodySmall),
                if (action != null) action!,
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// Asks before a destructive action; the confirm button repeats the verb.
Future<bool> confirmDestructive(
  BuildContext context, {
  required String title,
  required String message,
  required String confirmLabel,

  /// The dismiss button; name it when the action itself is a cancellation.
  String cancelLabel = '취소',
}) async {
  final ok = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(title),
      content: Text(message),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(ctx).pop(false),
          child: Text(cancelLabel),
        ),
        FilledButton(
          style: FilledButton.styleFrom(
            backgroundColor: const Color(0xFFB3261E),
          ),
          onPressed: () => Navigator.of(ctx).pop(true),
          child: Text(confirmLabel),
        ),
      ],
    ),
  );
  return ok == true;
}

void showSnack(BuildContext context, String text) {
  ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
}
