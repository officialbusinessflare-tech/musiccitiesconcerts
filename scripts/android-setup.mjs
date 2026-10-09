/**
 * Post-`cap add android` configuration for the Google Play build.
 *
 * Runs in CI (Codemagic) AFTER `npx cap add android`, which regenerates the
 * android/ folder from the Capacitor template (android/ is gitignored, like
 * ios/). This script layers in the three things the template does not set:
 *   1. applicationId = com.businessflare.musiccities
 *      (the Capacitor appId is com.themusiccities.app for iOS; the existing
 *       Play listing is com.businessflare.musiccities, so the Android package
 *       must match that listing. The code namespace is left unchanged.)
 *   2. versionCode / versionName (versionCode from $BUILD_NUMBER)
 *   3. A release signingConfig that reads the upload keystore from the
 *      Codemagic-injected env vars (CM_KEYSTORE_PATH, CM_KEYSTORE_PASSWORD,
 *      CM_KEY_ALIAS, CM_KEY_PASSWORD), wired into buildTypes.release.
 *
 * Idempotent: safe to run more than once.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const GRADLE = 'android/app/build.gradle';
const PLAY_APP_ID = 'com.businessflare.musiccities';
const VERSION_CODE = parseInt(process.env.BUILD_NUMBER || '1', 10);
const VERSION_NAME = process.env.VERSION_NAME || '1.0';

function log(m) { console.log(`[android-setup] ${m}`); }

let g = readFileSync(GRADLE, 'utf8');

// 1. applicationId -> Play package
g = g.replace(/applicationId\s+"[^"]*"/, `applicationId "${PLAY_APP_ID}"`);
log(`applicationId = ${PLAY_APP_ID}`);

// 2. versionCode / versionName
g = g.replace(/versionCode\s+\d+/, `versionCode ${VERSION_CODE}`);
g = g.replace(/versionName\s+"[^"]*"/, `versionName "${VERSION_NAME}"`);
log(`versionCode = ${VERSION_CODE}, versionName = ${VERSION_NAME}`);

// 3. signingConfigs.release (reads Codemagic keystore env), applied to release
if (!g.includes('signingConfigs {')) {
  const signing = `    signingConfigs {
        release {
            def ksPath = System.getenv("CM_KEYSTORE_PATH")
            if (ksPath) {
                storeFile file(ksPath)
                storePassword System.getenv("CM_KEYSTORE_PASSWORD")
                keyAlias System.getenv("CM_KEY_ALIAS")
                keyPassword System.getenv("CM_KEY_PASSWORD")
            }
        }
    }
`;
  // insert right after the first `android {` line
  g = g.replace(/android\s*\{\s*\n/, (m) => m + signing);
  log('inserted signingConfigs.release');
}

// wire release build type to the release signing config
if (!/release\s*\{[^}]*signingConfig\s+signingConfigs\.release/s.test(g)) {
  g = g.replace(/(buildTypes\s*\{\s*\n\s*release\s*\{\s*\n)/, `$1            signingConfig signingConfigs.release\n`);
  log('release buildType -> signingConfigs.release');
}

writeFileSync(GRADLE, g);
log('done');
