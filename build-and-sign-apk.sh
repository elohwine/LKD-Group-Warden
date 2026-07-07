#!/bin/bash

# ========= CONFIGURATION =========
APP_NAME="LDK Warden"
PACKAGE_NAME="com.ldk.warden"
KEYSTORE_PATH="$HOME/kiosk-epermit-mui-v5/android.keystore"
KEYSTORE_ALIAS="android"
KEYSTORE_PASS="developer123"
KEYPASS="developer123"
SDK_VERSION="33.0.2"
ANDROID_SDK_ROOT="$HOME/Android/Sdk"
APP_PATH="android/app/build/outputs/apk/release/app-release.apk"

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
print_step "Building PWA (Next build + export to out/)..."
npm run build:web || { echo "${RED}PWA build/export failed${NC}"; exit 1; }

# ========= STEP 4 — GENERATE NATIVE ASSETS & SYNC =========
print_step "Generating native assets and syncing to Android..."
npx cap sync android || { echo "${RED}Capacitor sync failed${NC}"; exit 1; }

# ========= STEP 5 — CONFIGURE SIGNING =========
print_step "Injecting signing configuration..."
cd android
SIGNING_FILE="app/build.gradle"

if ! grep -q "signingConfigs" $SIGNING_FILE; then
cat <<EOL >> $SIGNING_FILE

android {
    signingConfigs {
        release {
            storeFile file("$KEYSTORE_PATH")
            storePassword "$KEYSTORE_PASS"
            keyAlias "$KEYSTORE_ALIAS"
            keyPassword "$KEYPASS"
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
        }
    }
}
EOL
fi

# ========= STEP 6 — BUILD SIGNED APK =========
print_step "Cleaning previous Android build outputs..."
# Clean Gradle caches for a fresh build
./gradlew clean -q || { echo "${RED}Gradle clean failed${NC}"; exit 1; }
# Remove any leftover outputs (APKs/AABs) and transient build dirs
rm -rf app/build/outputs/apk/* app/build/outputs/bundle/* app/build/intermediates/* app/build/generated/* app/build/tmp/* || true

print_step "Building signed APK..."
./gradlew assembleRelease || { echo "${RED}Gradle build failed${NC}"; exit 1; }

# ========= STEP 7 — VERIFY APK SIGNATURE =========
print_step "Verifying APK signature..."
$ANDROID_SDK_ROOT/build-tools/$SDK_VERSION/apksigner verify --verbose $APP_PATH
if [ $? -ne 0 ]; then
    echo -e "${RED}APK signature verification failed!${NC}"
    exit 1
fi

# ========= STEP 8 — INSTALL ON DEVICE =========
print_step "Checking connected devices..."
adb devices

read -p "Do you want to install APK on device? (y/n): " confirm
if [[ "$confirm" =~ ^[Yy]$ ]]; then
    adb install -r $APP_PATH
    echo -e "${GREEN}APK installed successfully!${NC}"
else
    echo -e "${YELLOW}Skipped installation.${NC}"
fi

echo -e "${GREEN}✅ Done! Signed APK is at:${NC} $APP_PATH"
