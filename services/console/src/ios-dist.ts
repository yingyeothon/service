/**
 * iOS ad-hoc OTA install support (ported from the legacy catalog).
 * An ad-hoc `.ipa` gets a `manifest.plist` next to it on the public CDN and is
 * installed through an `itms-services://` link pointing at that manifest.
 */

export const IOS_AD_HOC = "ad-hoc";
export const MANIFEST_FILENAME = "manifest.plist";

/** `app/2db87899/app.ipa` → `app/2db87899/manifest.plist`. */
export function manifestKey(packageObjectKey: string): string {
  const cleaned = packageObjectKey.trim().replace(/^\/+|\/+$/g, "");
  if (!cleaned) return MANIFEST_FILENAME;
  const dir = cleaned.includes("/")
    ? cleaned.slice(0, cleaned.lastIndexOf("/"))
    : "";
  return dir ? `${dir}/${MANIFEST_FILENAME}` : MANIFEST_FILENAME;
}

/** Manifest URL sitting next to the package URL; https only. */
export function manifestUrlForPackageUrl(packageUrl: string): string {
  const parsed = new URL(packageUrl.trim());
  if (parsed.protocol !== "https:")
    throw new Error("package URL must use https");
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = `/${manifestKey(parsed.pathname)}`;
  return parsed.toString();
}

export function installUrl(manifestUrl: string): string {
  const parsed = new URL(manifestUrl.trim());
  if (parsed.protocol !== "https:")
    throw new Error("manifest URL must use https");
  return `itms-services://?action=download-manifest&url=${encodeURIComponent(parsed.toString())}`;
}

function escapeXml(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export interface ManifestInput {
  packageUrl: string;
  bundleId: string;
  bundleVersion: string;
  title: string;
}

export function manifestPlist({
  packageUrl,
  bundleId,
  bundleVersion,
  title,
}: ManifestInput): string {
  const url = packageUrl.trim();
  const id = bundleId.trim();
  const version = bundleVersion.trim();
  const name = title.trim();
  if (!url || !id || !version || !name)
    throw new Error("packageUrl, bundleId, bundleVersion, title are required");
  manifestUrlForPackageUrl(url); // validates https + host
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
 "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key>
          <string>software-package</string>
          <key>url</key>
          <string>${escapeXml(url)}</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key>
        <string>${escapeXml(id)}</string>
        <key>bundle-version</key>
        <string>${escapeXml(version)}</string>
        <key>kind</key>
        <string>software</string>
        <key>title</key>
        <string>${escapeXml(name)}</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>
`;
}
