#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="${IOS_PROJECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$PROJECT_ROOT"

CONFIG_FILE="${IOS_BUILD_CONFIG:-ios/build.env}"
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi
# The team id stays out of the public repo: it comes from the gitignored local
# file (or the environment) and is injected at build time.
IOS_LOCAL_ENV="${IOS_LOCAL_ENV:-../../local/console-app/ios.env}"
if [[ -f "$IOS_LOCAL_ENV" ]]; then
  # shellcheck disable=SC1090
  source "$IOS_LOCAL_ENV"
fi
IOS_DART_DEFINES="${IOS_DART_DEFINES:-../../local/console-app/firebase.prod.json}"

: "${IOS_BUNDLE_ID:?Set IOS_BUNDLE_ID in ios/build.env or the environment.}"

CATA_APP_NAME="${CATA_APP_NAME:-$(basename "$PROJECT_ROOT")}"
IOS_MINIMUM_OS_VERSION="${IOS_MINIMUM_OS_VERSION:-15.5}"
IOS_ARTIFACT_DIR="${IOS_ARTIFACT_DIR:-build/ios/artifacts}"

usage() {
  cat <<EOF
Usage:
  tools/build_ios.sh list-devices
  DEVICE_ID=<device-id> tools/build_ios.sh install-device
  tools/build_ios.sh development
  tools/build_ios.sh ad-hoc
  tools/build_ios.sh app-store
  tools/build_ios.sh upload-ad-hoc
  tools/build_ios.sh upload-app-store
  tools/build_ios.sh build-upload-ad-hoc
  tools/build_ios.sh build-upload-app-store

Config:
  $CONFIG_FILE

Required config values:
  IOS_BUNDLE_ID
  IOS_TEAM_ID (signing commands; from IOS_LOCAL_ENV)

Optional config/environment values:
  IOS_LOCAL_ENV (default ../../local/console-app/ios.env)
  IOS_DART_DEFINES (default ../../local/console-app/firebase.prod.json)
  YYT_PROFILE (dev|prod, upload target)
  CATA_APP_NAME
  IOS_MINIMUM_OS_VERSION
  IOS_ARTIFACT_DIR
  CI_KEYCHAIN_PATH
  CI_KEYCHAIN_PASSWORD
  IOS_SKIP_SIGNING_PREFLIGHT=1
  IOS_ALLOW_WILDCARD_PROFILE=1
  IOS_UPLOAD_STAGE
  IOS_UPLOAD_BUILD_LABEL
  IOS_UPLOAD_CHANGELOG

Notes:
  upload-* commands use the method-specific manifest in IOS_ARTIFACT_DIR.
  build-upload-* commands upload the IPA to the console catalog (yyt) artifact tracking only.
  App Store/TestFlight submission still requires App Store Connect tooling.
EOF
}

log() {
  printf '[%s] %s\n' "$(date +'%T')" "$*"
}

require_tool() {
  command -v "$1" >/dev/null || {
    echo "Missing required tool: $1" >&2
    exit 1
  }
}

prepare_keychain() {
  local keychain_path="${CI_KEYCHAIN_PATH:-$HOME/Library/Keychains/login.keychain-db}"

  if [[ -n "${CI_KEYCHAIN_PASSWORD:-}" ]]; then
    log "Unlocking keychain: $keychain_path"
    security unlock-keychain -p "$CI_KEYCHAIN_PASSWORD" "$keychain_path"
    security set-key-partition-list \
      -S apple-tool:,apple:,codesign: \
      -s \
      -k "$CI_KEYCHAIN_PASSWORD" \
      "$keychain_path" >/dev/null
  fi
}

required_identity_name() {
  case "$1" in
    development)
      printf 'Apple Development\n'
      ;;
    ad-hoc|app-store)
      printf 'Apple Distribution\n'
      ;;
    *)
      echo "Unsupported iOS distribution method: $1" >&2
      exit 2
      ;;
  esac
}

require_signing_identity() {
  local method="$1"
  local identity_name identities identity_hash
  identity_name="$(required_identity_name "$method")"

  if [[ "${IOS_SKIP_SIGNING_PREFLIGHT:-0}" == "1" ]]; then
    log "Skipping signing identity preflight for $method."
    return
  fi

  identities="$(security find-identity -v -p codesigning 2>&1 || true)"
  identity_hash="$(awk -v name="$identity_name" '$0 ~ name {print $2; exit}' <<<"$identities")"
  if [[ -z "$identity_hash" ]]; then
    cat >&2 <<EOF
No usable "$identity_name" code-signing identity is available to this shell.

Fix on the Mac running this script:
  1. Confirm the certificate and private key are installed in Keychain Access.
  2. Run with CI_KEYCHAIN_PASSWORD set so this script can unlock the keychain and grant codesign access.
  3. Re-authenticate Xcode Settings > Accounts for team $IOS_TEAM_ID, then install/download the needed profiles.

Current security find-identity output:
$identities
EOF
    exit 1
  fi

  require_codesign_access "$identity_hash" "$identity_name"
}

require_codesign_access() {
  local identity_hash="$1"
  local identity_name="$2"
  local test_dir test_binary output

  test_dir="$(mktemp -d)"
  test_binary="$test_dir/codesign-test"
  cp /bin/echo "$test_binary"

  if ! output="$(codesign --force --sign "$identity_hash" "$test_binary" 2>&1)"; then
    rm -rf "$test_dir"
    cat >&2 <<EOF
"$identity_name" exists, but command-line codesign cannot use its private key.

codesign output:
$output

Fix on the Mac running this script:
  1. Unlock the login keychain.
  2. Grant command-line codesign access to private keys:
     security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "<login-keychain-password>" ~/Library/Keychains/login.keychain-db
  3. Or rerun this script with CI_KEYCHAIN_PASSWORD set so it can do the unlock and partition-list step.
EOF
    exit 1
  fi

  rm -rf "$test_dir"
}

profile_xml() {
  local profile="$1"
  openssl smime -inform der -verify -noverify -in "$profile" 2>/dev/null
}

profile_value_from_xml() {
  local xml="$1"
  local key="$2"
  /usr/libexec/PlistBuddy -c "Print :$key" "$xml" 2>/dev/null || true
}

profile_has_key_from_xml() {
  local xml="$1"
  local key="$2"
  /usr/libexec/PlistBuddy -c "Print :$key" "$xml" >/dev/null 2>&1
}

profile_matches_method() {
  local xml="$1"
  local method="$2"
  local app_id get_task_allow has_devices

  app_id="$(profile_value_from_xml "$xml" "Entitlements:application-identifier")"
  if [[ "$app_id" != "$IOS_TEAM_ID.$IOS_BUNDLE_ID" ]]; then
    if [[ "$app_id" != "$IOS_TEAM_ID.*" ]]; then
      return 1
    fi
    if [[ "$method" != "development" && "${IOS_ALLOW_WILDCARD_PROFILE:-0}" != "1" ]]; then
      return 1
    fi
  fi

  get_task_allow="$(profile_value_from_xml "$xml" "Entitlements:get-task-allow")"
  if profile_has_key_from_xml "$xml" "ProvisionedDevices:0"; then
    has_devices=1
  else
    has_devices=0
  fi

  case "$method" in
    development)
      [[ "$get_task_allow" == "true" ]]
      ;;
    ad-hoc)
      [[ "$get_task_allow" == "false" && "$has_devices" == "1" ]]
      ;;
    app-store)
      [[ "$get_task_allow" == "false" && "$has_devices" == "0" ]]
      ;;
    *)
      return 1
      ;;
  esac
}

find_provisioning_profile() {
  local method="$1"
  local profile_dirs=(
    "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
    "$HOME/Library/MobileDevice/Provisioning Profiles"
  )
  local profile_dir profile xml app_id

  FOUND_PROFILE_NAME=""
  FOUND_PROFILE_PATH=""
  FOUND_PROFILE_XCODE_MANAGED="false"
  FOUND_PROFILE_WILDCARD="false"

  for profile_dir in "${profile_dirs[@]}"; do
    [[ -d "$profile_dir" ]] || continue
    while IFS= read -r -d '' profile; do
      xml="$(mktemp)"
      if ! profile_xml "$profile" >"$xml"; then
        rm -f "$xml"
        continue
      fi

      if profile_matches_method "$xml" "$method"; then
        app_id="$(profile_value_from_xml "$xml" "Entitlements:application-identifier")"
        FOUND_PROFILE_NAME="$(profile_value_from_xml "$xml" "Name")"
        FOUND_PROFILE_PATH="$profile"
        FOUND_PROFILE_XCODE_MANAGED="$(profile_value_from_xml "$xml" "IsXcodeManaged")"
        if [[ "$app_id" == "$IOS_TEAM_ID.*" ]]; then
          FOUND_PROFILE_WILDCARD="true"
        fi
        rm -f "$xml"
        return 0
      fi

      rm -f "$xml"
    done < <(find "$profile_dir" -name '*.mobileprovision' -print0)
  done

  return 1
}

require_provisioning_profile() {
  local method="$1"

  if [[ "${IOS_SKIP_SIGNING_PREFLIGHT:-0}" == "1" ]]; then
    log "Skipping provisioning profile preflight for $method."
    return
  fi

  if ! find_provisioning_profile "$method"; then
    cat >&2 <<EOF
No installed provisioning profile matches $method for $IOS_BUNDLE_ID under team $IOS_TEAM_ID.

Profile rules:
  development: get-task-allow=true; exact app id or team wildcard is allowed.
  ad-hoc: get-task-allow=false and ProvisionedDevices must exist.
  app-store: get-task-allow=false and ProvisionedDevices must not exist.

Install a matching profile, or set IOS_SKIP_SIGNING_PREFLIGHT=1 only for a flow that signs later.
EOF
    exit 1
  fi

  log "Found matching $method provisioning profile: $FOUND_PROFILE_NAME"
  if [[ "$FOUND_PROFILE_WILDCARD" == "true" ]]; then
    log "Using wildcard provisioning profile for $IOS_BUNDLE_ID"
  fi
}

plist_escape() {
  sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' \
    -e "s/'/\&apos;/g"
}

create_manual_export_options() {
  local method="$1"
  local profile_name="$2"
  local output="$3"
  local identity_name
  identity_name="$(required_identity_name "$method")"

  cat >"$output" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>$(printf '%s' "$method" | plist_escape)</string>
	<key>signingCertificate</key>
	<string>$(printf '%s' "$identity_name" | plist_escape)</string>
	<key>signingStyle</key>
	<string>manual</string>
	<key>teamID</key>
	<string>$(printf '%s' "$IOS_TEAM_ID" | plist_escape)</string>
	<key>provisioningProfiles</key>
	<dict>
		<key>$(printf '%s' "$IOS_BUNDLE_ID" | plist_escape)</key>
		<string>$(printf '%s' "$profile_name" | plist_escape)</string>
	</dict>
</dict>
</plist>
PLIST
}

export_options_plist() {
  local method="$1"
  local plist

  if [[ "${IOS_SKIP_SIGNING_PREFLIGHT:-0}" == "1" || "$FOUND_PROFILE_XCODE_MANAGED" == "true" ]]; then
    # The checked-in plist carries no team id; add it to a temporary copy.
    plist="$(mktemp "${TMPDIR:-/tmp}/flutter-ios-export-options.XXXXXX.plist")"
    cp "ios/ExportOptions.$method.plist" "$plist"
    /usr/libexec/PlistBuddy -c "Add :teamID string $IOS_TEAM_ID" "$plist" >/dev/null
    printf '%s\n' "$plist"
    return 0
  fi

  plist="$(mktemp "${TMPDIR:-/tmp}/flutter-ios-export-options.XXXXXX.plist")"
  create_manual_export_options "$method" "$FOUND_PROFILE_NAME" "$plist"
  printf '%s\n' "$plist"
}

preflight_common() {
  : "${IOS_TEAM_ID:?Set IOS_TEAM_ID in $IOS_LOCAL_ENV or the environment.}"
  # Flutter passes FLUTTER_XCODE_* variables to xcodebuild as build settings.
  export FLUTTER_XCODE_DEVELOPMENT_TEAM="$IOS_TEAM_ID"
  require_tool flutter
  require_tool xcodebuild
  require_tool security
  require_tool codesign
  require_tool openssl
  prepare_keychain
  flutter --version
  xcodebuild -version
  xcodebuild -list -workspace ios/Runner.xcworkspace >/dev/null
}

latest_ipa() {
  local ipa
  ipa="$(ls -t build/ios/ipa/*.ipa 2>/dev/null | head -n 1 || true)"
  [[ -n "$ipa" ]] || {
    echo "No IPA found under build/ios/ipa." >&2
    exit 1
  }
  printf '%s\n' "$ipa"
}

pubspec_version() {
  awk '/^version:/ {print $2; exit}' pubspec.yaml
}

record_ipa_manifest() {
  local method="$1"
  local ipa="$2"
  mkdir -p "$IOS_ARTIFACT_DIR"
  cat >"$IOS_ARTIFACT_DIR/$method.env" <<EOF
IPA_PATH=$ipa
DISTRIBUTION_METHOD=$method
BUNDLE_ID=$IOS_BUNDLE_ID
VERSION=$(pubspec_version)
EOF
}

# Sets DART_DEFINE_ARGS (an array, so a path with spaces stays one argument).
set_dart_define_args() {
  DART_DEFINE_ARGS=()
  if [[ -f "$IOS_DART_DEFINES" ]]; then
    DART_DEFINE_ARGS=(--dart-define-from-file="$IOS_DART_DEFINES")
  else
    echo "warning: $IOS_DART_DEFINES not found; building with push notices off." >&2
  fi
}

build_ipa() {
  local method="$1"
  local plist ipa

  preflight_common
  require_signing_identity "$method"
  require_provisioning_profile "$method"
  plist="$(export_options_plist "$method")"

  log "Building iOS $method IPA for $IOS_BUNDLE_ID"
  rm -f build/ios/ipa/*.ipa 2>/dev/null || true
  set_dart_define_args
  flutter build ipa --release --export-options-plist="$plist" ${DART_DEFINE_ARGS[@]+"${DART_DEFINE_ARGS[@]}"}

  ipa="$(latest_ipa)"
  record_ipa_manifest "$method" "$ipa"
  printf '%s\n' "$ipa"
}

upload_ipa() {
  local method="$1"
  local manifest="$IOS_ARTIFACT_DIR/$method.env"
  require_tool yyt
  # No silent fallback to the config's default profile (it may be prod).
  : "${YYT_PROFILE:?Set YYT_PROFILE=dev|prod for the upload target.}"

  [[ -f "$manifest" ]] || {
    echo "No recorded $method IPA manifest found. Run tools/build_ios.sh $method first." >&2
    exit 1
  }

  local ipa="" distribution_method="" built_bundle_id="" built_version=""
  while IFS='=' read -r key value; do
    case "$key" in
      IPA_PATH) ipa="$value" ;;
      DISTRIBUTION_METHOD) distribution_method="$value" ;;
      BUNDLE_ID) built_bundle_id="$value" ;;
      VERSION) built_version="$value" ;;
    esac
  done <"$manifest"

  if [[ "$distribution_method" != "$method" || "$built_bundle_id" != "$IOS_BUNDLE_ID" ]]; then
    echo "Recorded IPA metadata does not match requested upload method or bundle id." >&2
    echo "manifest=$manifest method=$distribution_method bundle_id=$built_bundle_id" >&2
    exit 1
  fi

  [[ -f "$ipa" ]] || {
    echo "Recorded IPA does not exist: $ipa" >&2
    exit 1
  }

  local version build_number commit
  version="${built_version%%+*}"
  build_number="${built_version##*+}"
  if [[ -z "$version" || -z "$build_number" || "$version" == "$build_number" ]]; then
    echo "pubspec.yaml version must include a build number, e.g. 1.0.18+19." >&2
    exit 1
  fi

  # Same version string as the release's APK (x.y.z+build); the optional
  # tags are added only when set, an empty --tag value is rejected.
  local -a extra=()
  [[ -n "${IOS_UPLOAD_STAGE:-}" ]] && extra+=(--stage "$IOS_UPLOAD_STAGE")
  [[ -n "${IOS_UPLOAD_CHANGELOG:-}" ]] && extra+=(--changelog "$IOS_UPLOAD_CHANGELOG")
  [[ -n "${IOS_UPLOAD_BUILD_LABEL:-}" ]] && extra+=(--tag "build=$IOS_UPLOAD_BUILD_LABEL")
  commit="$(git rev-parse --short HEAD 2>/dev/null || true)"
  [[ -n "$commit" ]] && extra+=(--tag "commit=$commit")

  export YYT_TEAM="${YYT_TEAM:-platform}"
  export YYT_PROJECT="${YYT_PROJECT:-console}"
  yyt catalog artifact upload ios \
    "$CATA_APP_NAME" \
    "$ipa" \
    --version "$built_version" \
    --build-number "$build_number" \
    --bundle-id "$IOS_BUNDLE_ID" \
    --minimum-os-version "$IOS_MINIMUM_OS_VERSION" \
    --distribution-method "$method" \
    --tag "title=잉여톤" \
    ${extra[@]+"${extra[@]}"}
}

install_device() {
  : "${DEVICE_ID:?Set DEVICE_ID to the connected iPhone or iPad id.}"
  preflight_common
  require_tool xcrun
  require_signing_identity development
  require_provisioning_profile development

  set_dart_define_args
  flutter build ios --release ${DART_DEFINE_ARGS[@]+"${DART_DEFINE_ARGS[@]}"}
  xcrun devicectl device install app \
    --device "$DEVICE_ID" \
    build/ios/iphoneos/Runner.app
}

cmd="${1:-}"
case "$cmd" in
  list-devices)
    require_tool xcrun
    xcrun devicectl list devices
    ;;
  install-device)
    install_device
    ;;
  development)
    build_ipa development
    ;;
  ad-hoc)
    build_ipa ad-hoc
    ;;
  app-store)
    build_ipa app-store
    ;;
  upload-ad-hoc)
    upload_ipa ad-hoc
    ;;
  upload-app-store)
    upload_ipa app-store
    ;;
  build-upload-ad-hoc)
    build_ipa ad-hoc
    upload_ipa ad-hoc
    ;;
  build-upload-app-store)
    build_ipa app-store
    upload_ipa app-store
    ;;
  -h|--help|help|"")
    usage
    ;;
  *)
    usage
    exit 64
    ;;
esac
