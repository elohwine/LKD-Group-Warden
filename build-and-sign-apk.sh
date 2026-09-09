#!/bin/bash

# ========= CONFIGURATION =========
APP_NAME="LDK Warden"
PACKAGE_NAME="com.ldk.warden.mobile"
SDK_VERSION="33.0.2"
ANDROID_SDK_ROOT="$HOME/Android/Sdk"
APP_PATH=""
ANDROID_GRADLE_PROPERTIES="android/gradle.properties"

load_env_file_if_present() {
    local env_file="$1"
    if [ -f "$env_file" ]; then
        set -a
        # shellcheck disable=SC1090
        . "$env_file"
        set +a
    fi
}

ensure_public_firebase_config() {
    # Only pull from env files when public Firebase vars are not already provided.
    if [ -z "${NEXT_PUBLIC_FIREBASE_API_KEY:-}" ] || [ -z "${NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN:-}" ] || [ -z "${NEXT_PUBLIC_FIREBASE_PROJECT_ID:-}" ] || [ -z "${NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET:-}" ] || [ -z "${NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID:-}" ] || [ -z "${NEXT_PUBLIC_FIREBASE_APP_ID:-}" ]; then
        load_env_file_if_present ".env.local"
        load_env_file_if_present ".env.production"
    fi

    export NEXT_PUBLIC_FIREBASE_API_KEY="${NEXT_PUBLIC_FIREBASE_API_KEY:-AIzaSyDlnhEMK0DkgyPYTsgnO0HFgldywKK1fFc}"
    export NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN="${NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN:-ldk-group-e-permits-system.firebaseapp.com}"
    export NEXT_PUBLIC_FIREBASE_PROJECT_ID="${NEXT_PUBLIC_FIREBASE_PROJECT_ID:-ldk-group-e-permits-system}"
    export NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET="${NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET:-ldk-group-e-permits-system.appspot.com}"
    export NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID="${NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID:-203247315284}"
    export NEXT_PUBLIC_FIREBASE_APP_ID="${NEXT_PUBLIC_FIREBASE_APP_ID:-1:203247315284:web:699c0401c754c5a11ac0c1}"
    export NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID="${NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID:-G-DKR8PCRGB5}"

    require_env NEXT_PUBLIC_FIREBASE_API_KEY
    require_env NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
    require_env NEXT_PUBLIC_FIREBASE_PROJECT_ID
    require_env NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
    require_env NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID
    require_env NEXT_PUBLIC_FIREBASE_APP_ID
}

validate_public_api_base() {
    local base="${NEXT_PUBLIC_API_BASE_URL:-}"
    local secondary="${NEXT_PUBLIC_API_BASE_URL_SECONDARY:-}"

    # Respect inline/exported values first. Only fall back to env files when unset.
    if [ -z "$base" ]; then
        load_env_file_if_present ".env.local"
        load_env_file_if_present ".env.production"
        base="${NEXT_PUBLIC_API_BASE_URL:-}"
        secondary="${NEXT_PUBLIC_API_BASE_URL_SECONDARY:-$secondary}"
    fi

    if [ -z "$base" ]; then
        echo -e "${RED}NEXT_PUBLIC_API_BASE_URL is required for APK builds.${NC}"
        echo -e "${YELLOW}Set exactly one API host per test run (for example: https://www.ldkgroup.co.uk or https://ldk-group-ltd-website-react-p2ea.onrender.com).${NC}"
        exit 1
    fi

    if [[ ! "$base" =~ ^https?:// ]]; then
        base="https://$base"
    fi

    base="${base%/}"
    secondary="${secondary%/}"

    if [[ ! "$base" =~ ^https://(www\.ldkgroup\.co\.uk|ldkgroup\.co\.uk|ldk-group-ltd-website-react-p2ea\.onrender\.com)$ ]]; then
        echo -e "${RED}NEXT_PUBLIC_API_BASE_URL must point to www.ldkgroup.co.uk, ldkgroup.co.uk, or ldk-group-ltd-website-react-p2ea.onrender.com over HTTPS (got: $base)${NC}"
        exit 1
    fi

    # Single-source API mode: disable secondary host fallback in APK builds.
    secondary=""

    export NEXT_PUBLIC_API_BASE_URL="$base"
    export NEXT_PUBLIC_API_BASE_URL_SECONDARY="$secondary"
}

validate_camera_service_base() {
    local base="${NEXT_PUBLIC_CAMERA_SERVICE_BASE_URL:-${CAMERA_SERVICE_BASE_URL:-}}"

    # Respect inline/exported values first. Only fall back to env files when unset.
    if [ -z "$base" ]; then
        # Loading env files can unintentionally overwrite NEXT_PUBLIC_API_BASE_URL.
        # Preserve it so API preflight output stays deterministic.
        local preserved_api_base="${NEXT_PUBLIC_API_BASE_URL:-}"
        load_env_file_if_present ".env.local"
        load_env_file_if_present ".env.production"
        if [ -n "$preserved_api_base" ]; then
            export NEXT_PUBLIC_API_BASE_URL="$preserved_api_base"
        fi
        base="${NEXT_PUBLIC_CAMERA_SERVICE_BASE_URL:-${CAMERA_SERVICE_BASE_URL:-}}"
    fi

    if [ -z "$base" ]; then
        echo -e "${RED}NEXT_PUBLIC_CAMERA_SERVICE_BASE_URL is required for APK builds.${NC}"
        echo -e "${YELLOW}Expected value example: https://ldk-group-camera-service.onrender.com${NC}"
        exit 1
    fi

    if [[ ! "$base" =~ ^https?:// ]]; then
        echo -e "${RED}NEXT_PUBLIC_CAMERA_SERVICE_BASE_URL must include http:// or https:// (got: $base)${NC}"
        exit 1
    fi

    base="${base%/}"

    # Never keep www camera host as first preference for APK builds.
    if [[ "$base" =~ ^https://www\.camera\.ldkgroup\.co\.uk$ ]]; then
        base="https://camera.ldkgroup.co.uk"
    fi

    if [[ ! "$base" =~ ^https?://(([a-zA-Z0-9-]+\.)*ldkgroup\.co\.uk|ldk-group-camera-service\.onrender\.com)$ ]]; then
        echo -e "${RED}NEXT_PUBLIC_CAMERA_SERVICE_BASE_URL must point to *.ldkgroup.co.uk or ldk-group-camera-service.onrender.com (got: $base)${NC}"
        exit 1
    fi

    export NEXT_PUBLIC_CAMERA_SERVICE_BASE_URL="$base"
}

print_preflight_api_targets() {
    require_env NEXT_PUBLIC_API_BASE_URL
    require_env NEXT_PUBLIC_CAMERA_SERVICE_BASE_URL

    echo -e "${GREEN}APK preflight API targets:${NC}"
    echo -e "  NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}"
    if [ -n "${NEXT_PUBLIC_API_BASE_URL_SECONDARY:-}" ]; then
        echo -e "  NEXT_PUBLIC_API_BASE_URL_SECONDARY=${NEXT_PUBLIC_API_BASE_URL_SECONDARY}"
    fi
    echo -e "  NEXT_PUBLIC_CAMERA_SERVICE_BASE_URL=${NEXT_PUBLIC_CAMERA_SERVICE_BASE_URL}"
}

require_env() {
    local name="$1"
    local value="${!name:-}"
    if [ -z "$value" ]; then
        echo -e "${RED}Missing required environment variable: $name${NC}"
        exit 1
    fi
}

set_gradle_property() {
    local key="$1"
    local value="$2"

    if [ ! -f "$ANDROID_GRADLE_PROPERTIES" ]; then
        echo -e "${RED}Missing ${ANDROID_GRADLE_PROPERTIES}${NC}"
        exit 1
    fi

    if grep -q "^${key}=" "$ANDROID_GRADLE_PROPERTIES"; then
        sed -i "s#^${key}=.*#${key}=${value}#" "$ANDROID_GRADLE_PROPERTIES"
    else
        printf "\n%s=%s\n" "$key" "$value" >> "$ANDROID_GRADLE_PROPERTIES"
    fi
}

resolve_signed_apk_path() {
    local signed_apk
    signed_apk=$(find android/app/build/outputs/apk/release -type f \( -iname '*signed*.apk' -o -iname '*-signed.apk' \) 2>/dev/null | sort | tail -n 1)
    if [ -z "$signed_apk" ]; then
        echo -e "${RED}Signed APK not found in android/app/build/outputs/apk/release${NC}"
        exit 1
    fi
    APP_PATH="$signed_apk"
}

prepare_release_versioning() {
    local current_code next_code package_version

    current_code=$(grep -E '^WARDEN_VERSION_CODE=' "$ANDROID_GRADLE_PROPERTIES" | tail -n 1 | cut -d'=' -f2)
    if [[ ! "$current_code" =~ ^[0-9]+$ ]]; then
        current_code=0
    fi
    next_code=$((current_code + 1))

    package_version=$(node -p "require('./package.json').version" 2>/dev/null)
    if [ -z "$package_version" ]; then
        package_version="1.0.0"
    fi

    set_gradle_property "WARDEN_VERSION_CODE" "$next_code"
    set_gradle_property "WARDEN_VERSION_NAME" "$package_version"

    export WARDEN_VERSION_CODE="$next_code"
    export WARDEN_VERSION_NAME="$package_version"

    echo -e "${GREEN}Using WARDEN_VERSION_CODE=${WARDEN_VERSION_CODE}${NC}"
    echo -e "${GREEN}Using WARDEN_VERSION_NAME=${WARDEN_VERSION_NAME}${NC}"
}

normalize_signing_env() {
    local repo_root
    repo_root="$(pwd)"
    local local_keystore="$repo_root/.keystore/warden-release.jks"

    if [ -z "${WARDEN_KEYSTORE_PATH:-}" ] || [ -z "${WARDEN_KEYSTORE_ALIAS:-}" ] || [ -z "${WARDEN_KEYSTORE_PASSWORD:-}" ] || [ -z "${WARDEN_KEY_PASSWORD:-}" ]; then
        load_env_file_if_present ".env.local"
        load_env_file_if_present ".env.production"
    fi

    if [ -z "${WARDEN_KEYSTORE_PATH:-}" ] && [ -f "$local_keystore" ]; then
        export WARDEN_KEYSTORE_PATH="$local_keystore"
    fi

    if [ -n "${WARDEN_KEYSTORE_PATH:-}" ] && [ ! -f "$WARDEN_KEYSTORE_PATH" ] && [ -f "$local_keystore" ]; then
        echo -e "${YELLOW}Adjusting WARDEN_KEYSTORE_PATH to local keystore: $local_keystore${NC}"
        export WARDEN_KEYSTORE_PATH="$local_keystore"
    fi

    if [ -z "${WARDEN_KEYSTORE_ALIAS:-}" ] && [ -n "${WARDEN_KEYSTORE_PATH:-}" ] && [ -f "$WARDEN_KEYSTORE_PATH" ]; then
        echo -e "${YELLOW}WARDEN_KEYSTORE_ALIAS is still unset after env loading; release signing will fail until it is provided.${NC}"
    fi
}

# ========= COLORS =========
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# ========= HELPER =========
print_step() {
    echo -e "${YELLOW}\n==> $1${NC}\n"
}

# ========= STEP 1 — CHECK DEPENDENCIES =========
print_step "Checking prerequisites..."
for cmd in java node npm npx wget unzip; do
    if ! command -v $cmd &> /dev/null; then
        echo -e "${RED}Missing dependency: $cmd${NC}"
        exit 1
    fi
done

# ========= STEP 2 — ENSURE ANDROID SDK =========
print_step "Ensuring Android SDK exists..."
mkdir -p "$ANDROID_SDK_ROOT/cmdline-tools"
cd "$ANDROID_SDK_ROOT/cmdline-tools"

if [ ! -d "latest" ]; then
        print_step "Downloading Android command-line tools..."
        wget -q https://dl.google.com/android/repository/commandlinetools-linux-9477386_latest.zip -O cmdline-tools.zip
        unzip -q cmdline-tools.zip
        rm -f cmdline-tools.zip
        mv cmdline-tools latest
fi

export PATH=$PATH:"$ANDROID_SDK_ROOT/cmdline-tools/latest/bin"
export PATH=$PATH:"$ANDROID_SDK_ROOT/platform-tools"
export PATH=$PATH:"$ANDROID_SDK_ROOT/build-tools/$SDK_VERSION"

# Only install SDK packages if not already present
if [ ! -x "$ANDROID_SDK_ROOT/build-tools/$SDK_VERSION/aapt" ] || [ ! -d "$ANDROID_SDK_ROOT/platforms/android-33" ]; then
    print_step "Installing SDK packages..."
    yes | sdkmanager "platform-tools" "build-tools;$SDK_VERSION" "platforms;android-33"
else
    print_step "SDK packages already installed. Skipping installation."
fi

cd - >/dev/null 2>&1 || true

# ========= STEP 3 — BUILD PWA =========
print_step "Validating mobile API base URL..."
validate_public_api_base
echo -e "${GREEN}Using NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}${NC}"

print_step "Validating camera service API base URL..."
validate_camera_service_base
echo -e "${GREEN}Using NEXT_PUBLIC_CAMERA_SERVICE_BASE_URL=${NEXT_PUBLIC_CAMERA_SERVICE_BASE_URL}${NC}"

# Camera env loading can repopulate NEXT_PUBLIC_API_BASE_URL from env files.
# Re-apply API base validation after that step.
validate_public_api_base

export NEXT_PUBLIC_DEMO_MODE="${NEXT_PUBLIC_DEMO_MODE:-false}"
echo -e "${GREEN}Using NEXT_PUBLIC_DEMO_MODE=${NEXT_PUBLIC_DEMO_MODE}${NC}"

print_step "APK API preflight summary..."
print_preflight_api_targets

print_step "Ensuring public Firebase client config..."
ensure_public_firebase_config
echo -e "${GREEN}Using NEXT_PUBLIC_FIREBASE_PROJECT_ID=${NEXT_PUBLIC_FIREBASE_PROJECT_ID}${NC}"

print_step "Preparing Android release versioning..."
prepare_release_versioning

normalize_signing_env

if [ -n "${CAPACITOR_SERVER_URL:-}" ]; then
    echo -e "${YELLOW}Ignoring CAPACITOR_SERVER_URL for Warden APK bundled mode: ${CAPACITOR_SERVER_URL}${NC}"
fi
unset CAPACITOR_SERVER_URL

print_step "Bundled mode enforced. Building PWA (Next build + export to out/)..."
npm run build:web || { echo "${RED}PWA build/export failed${NC}"; exit 1; }

# ========= STEP 4 — GENERATE NATIVE ASSETS & SYNC =========
print_step "Generating native assets and syncing to Android..."
npx cap sync android || { echo "${RED}Capacitor sync failed${NC}"; exit 1; }

# ========= STEP 5 — CONFIGURE SIGNING =========
print_step "Validating signing environment..."
require_env WARDEN_KEYSTORE_PATH
require_env WARDEN_KEYSTORE_ALIAS
require_env WARDEN_KEYSTORE_PASSWORD
require_env WARDEN_KEY_PASSWORD

cd android
SIGNING_FILE="app/build.gradle"

# ========= STEP 6 — BUILD SIGNED APK =========
print_step "Cleaning previous Android build outputs..."
# Clean Gradle caches for a fresh build
./gradlew clean -q || { echo "${RED}Gradle clean failed${NC}"; exit 1; }
# Remove any leftover outputs (APKs/AABs) and transient build dirs
rm -rf app/build/outputs/apk/* app/build/outputs/bundle/* app/build/intermediates/* app/build/generated/* app/build/tmp/* || true

print_step "Building signed APK..."
./gradlew assembleRelease || { echo "${RED}Gradle build failed${NC}"; exit 1; }

# Return to repo root (same pattern as kiosk)
cd - >/dev/null 2>&1 || true

# ========= STEP 7 — VERIFY APK SIGNATURE =========
print_step "Verifying APK signature..."
resolve_signed_apk_path
$ANDROID_SDK_ROOT/build-tools/$SDK_VERSION/apksigner verify --verbose $APP_PATH
if [ $? -ne 0 ]; then
    echo -e "${RED}APK signature verification failed!${NC}"
    exit 1
fi

# ========= STEP 8 — INSTALL ON DEVICE =========
print_step "Checking connected devices..."
adb devices

confirm="${INSTALL_ON_DEVICE:-n}"
if [[ -t 0 && -z "${INSTALL_ON_DEVICE:-}" ]]; then
    read -p "Do you want to install APK on device? (y/n): " confirm
fi

if [[ "$confirm" =~ ^[Yy]$ ]]; then
    adb install -r $APP_PATH
    echo -e "${GREEN}APK installed successfully!${NC}"
else
    echo -e "${YELLOW}Skipped installation.${NC}"
fi

echo -e "${GREEN}✅ Done! Signed APK is at:${NC} $APP_PATH"
