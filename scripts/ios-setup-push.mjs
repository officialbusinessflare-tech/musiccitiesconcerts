/**
 * Post-`cap add ios` configuration for native push notifications.
 *
 * Runs in CI (Codemagic) AFTER `npx cap add ios`, which regenerates the
 * ios/ folder from the Capacitor template. This script layers in the three
 * things the template does not include:
 *   1. ios/App/App/App.entitlements with aps-environment
 *   2. CODE_SIGN_ENTITLEMENTS build setting in the Xcode project (both configs)
 *   3. APNs device-token callbacks in AppDelegate.swift (forwarded to Capacitor)
 *
 * Idempotent: safe to run more than once.
 *
 * aps-environment: "production" for App Store / TestFlight builds (default),
 * override with APS_ENVIRONMENT=development for local device debugging.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const APS_ENV = process.env.APS_ENVIRONMENT || 'production';
const IOS = 'ios/App/App';
const PBXPROJ = 'ios/App/App.xcodeproj/project.pbxproj';
const APPDELEGATE = `${IOS}/AppDelegate.swift`;
const ENTITLEMENTS = `${IOS}/App.entitlements`;

function log(msg) { console.log(`[ios-setup-push] ${msg}`); }

// 1. Entitlements file
const entitlementsXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>aps-environment</key>
	<string>${APS_ENV}</string>
</dict>
</plist>
`;
writeFileSync(ENTITLEMENTS, entitlementsXml);
log(`wrote App.entitlements (aps-environment=${APS_ENV})`);

// 2. CODE_SIGN_ENTITLEMENTS build setting in every App-target config
let pbx = readFileSync(PBXPROJ, 'utf8');
const bundleLine = 'PRODUCT_BUNDLE_IDENTIFIER = com.themusiccities.app;';
if (!pbx.includes(bundleLine)) {
  throw new Error('Could not find App target bundle identifier in pbxproj; aborting.');
}
let injected = 0;
pbx = pbx.replace(new RegExp(`(\\n(\\s*))${bundleLine.replace(/\./g, '\\.')}`, 'g'), (match, pre, indent) => {
  // Skip if this config block already has the entitlements setting nearby.
  return `${pre}CODE_SIGN_ENTITLEMENTS = "App/App.entitlements";\n${indent}${bundleLine}`;
});
// De-duplicate in case the script ran twice: collapse repeated entitlement lines.
pbx = pbx.replace(/(CODE_SIGN_ENTITLEMENTS = "App\/App\.entitlements";\s*\n\s*)+(\s*CODE_SIGN_ENTITLEMENTS = "App\/App\.entitlements";)/g, '$2');
injected = (pbx.match(/CODE_SIGN_ENTITLEMENTS = "App\/App\.entitlements";/g) || []).length;
writeFileSync(PBXPROJ, pbx);
log(`CODE_SIGN_ENTITLEMENTS present in ${injected} build config(s)`);

// 3. AppDelegate push callbacks
let app = readFileSync(APPDELEGATE, 'utf8');
if (app.includes('capacitorDidRegisterForRemoteNotifications')) {
  log('AppDelegate already has push callbacks; skipping');
} else {
  const methods = `
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }
`;
  // Insert before the final closing brace of the class.
  const lastBrace = app.lastIndexOf('}');
  app = app.slice(0, lastBrace) + methods + app.slice(lastBrace);
  writeFileSync(APPDELEGATE, app);
  log('added APNs callbacks to AppDelegate.swift');
}

log('done.');

// 4. Shared Xcode scheme "App" (CI needs a shared scheme to build non-interactively)
import { mkdirSync } from 'node:fs';
(function writeScheme() {
  const schemeDir = 'ios/App/App.xcodeproj/xcshareddata/xcschemes';
  const schemePath = `${schemeDir}/App.xcscheme`;
  // Find the PBXNativeTarget UUID for "App".
  const pbxText = readFileSync(PBXPROJ, 'utf8');
  const m = pbxText.match(/([0-9A-F]{24}) \/\* App \*\/ = \{\s*\n\s*isa = PBXNativeTarget;/);
  const targetId = m ? m[1] : '504EC3031FED79650016851F';
  mkdirSync(schemeDir, { recursive: true });
  const scheme = `<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion = "1500" version = "1.7">
   <BuildAction parallelizeBuildables = "YES" buildImplicitDependencies = "YES">
      <BuildActionEntries>
         <BuildActionEntry buildForTesting = "YES" buildForRunning = "YES" buildForProfiling = "YES" buildForArchiving = "YES" buildForAnalyzing = "YES">
            <BuildableReference
               BuildableIdentifier = "primary"
               BlueprintIdentifier = "${targetId}"
               BuildableName = "App.app"
               BlueprintName = "App"
               ReferencedContainer = "container:App.xcodeproj">
            </BuildableReference>
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <TestAction buildConfiguration = "Debug" selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv = "YES">
      <Testables></Testables>
   </TestAction>
   <LaunchAction buildConfiguration = "Debug" selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB" launchStyle = "0" useCustomWorkingDirectory = "NO" ignoresPersistentStateOnLaunch = "NO" debugDocumentVersioning = "YES" debugServiceExtension = "internal" allowLocationSimulation = "YES">
      <BuildableProductRunnable runnableDebuggingMode = "0">
         <BuildableReference
            BuildableIdentifier = "primary"
            BlueprintIdentifier = "${targetId}"
            BuildableName = "App.app"
            BlueprintName = "App"
            ReferencedContainer = "container:App.xcodeproj">
         </BuildableReference>
      </BuildableProductRunnable>
   </LaunchAction>
   <ProfileAction buildConfiguration = "Release" shouldUseLaunchSchemeArgsEnv = "YES" savedToolIdentifier = "" useCustomWorkingDirectory = "NO" debugDocumentVersioning = "YES">
      <BuildableProductRunnable runnableDebuggingMode = "0">
         <BuildableReference
            BuildableIdentifier = "primary"
            BlueprintIdentifier = "${targetId}"
            BuildableName = "App.app"
            BlueprintName = "App"
            ReferencedContainer = "container:App.xcodeproj">
         </BuildableReference>
      </BuildableProductRunnable>
   </ProfileAction>
   <AnalyzeAction buildConfiguration = "Debug"></AnalyzeAction>
   <ArchiveAction buildConfiguration = "Release" revealArchiveInOrganizer = "YES"></ArchiveAction>
</Scheme>
`;
  writeFileSync(schemePath, scheme);
  log(`wrote shared scheme App.xcscheme (target ${targetId})`);
})();
