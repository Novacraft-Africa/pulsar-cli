# @novacraft-engineering/pulsar-cli

Release CLI for [Pulsar](https://usepulsar.dev) — the free, self-hostable **CodePush alternative** for React Native. Bundle your JavaScript, hash it exactly the way the on-device client does, and ship it over-the-air to live apps in seconds. No app-store review.

Microsoft App Center CodePush was retired in March 2025. Pulsar speaks the same CodePush protocol, so migrating is a deployment key and a server URL — not a rewrite. See [usepulsar.dev/codepush-alternative](https://usepulsar.dev/codepush-alternative).

## Install

```bash
npm i -g @novacraft-engineering/pulsar-cli
# or run without installing:
npx @novacraft-engineering/pulsar-cli login https://api.usepulsar.dev
```

`<apiUrl>` is whatever Pulsar server you release against. `api.usepulsar.dev`
is the hosted one; point it at your own if you self-host. The CLI talks to the
Pulsar API and nothing else, so it has no host compiled into it.

## Commands

```bash
pulsar login <apiUrl>                 # authenticate (API key or browser), saved to ~/.pulsar/config.json
                                      #   --api-key  paste a key from Settings → API keys
                                      #   --browser  sign in via the dashboard, no key to manage
pulsar apps                           # list your apps and deployment keys

pulsar release <app> <deployment> --platform ios|android --target <ver> \
       [--rollout 25] [--mandatory] [--disabled] [--devices id1,id2,...] [--description "fix crash"] \
       [--private-key key.pem] [--bundle-key <file>]
       [--plain-copy-for-old-builds | --plain | --only-older-builds]
       [--hermes | --no-hermes]

pulsar promote <app> <from> <to> [--rollout 100]
pulsar rollback <app> <deployment>

pulsar deployment ls <app>            # list deployments + keys
pulsar deployment add <app> <name>    # create a new deployment (e.g. QA)
pulsar history <app> <deployment>     # release history
pulsar patch <app> <deployment> <label> [--rollout N] [--mandatory] [--disable] [--enable] [--devices id1,id2,...]
pulsar migrate --from <serverUrl> --access-key <key>   # move apps from RevoPush / code-push-server (see below)

pulsar keygen                         # write pulsar-private.pem + pulsar-public.pem for code signing
pulsar bundle-key create --app <name> [--out <file>]   # create a private-bundles key (see below)
pulsar bundle-key id [--bundle-key <file>]             # print the key ids in PULSAR_BUNDLE_KEY or the file
pulsar changes --app <name> --deployment <dep> --label <vN>   # unlock a private release locally, print what changed
```

### Targeting a release's reach

- `--rollout N` — serve to a deterministic N% of devices (by `client_unique_id`).
- `--devices id1,id2` — serve **only** to those exact device ids (most granular). Empty = all devices.
- `--disabled` — upload the bundle but don't serve it (flip on later with `pulsar patch … --enable`).
- `--target <range>` — semver range of native binary versions the release applies to.

## How a release works

`release` runs the React Native bundler, computes the **CodePush package hash** (the exact
`path:sha256` manifest algorithm the on-device client uses — so a device that already has the
bundle correctly reports "up to date"), zips the output, and uploads it to Pulsar. The client
then downloads it in the background and swaps it in on next launch.

Auth is read from `PULSAR_API_URL` / `PULSAR_TOKEN` env, or `~/.pulsar/config.json` (written by `pulsar login`). Nothing is committed.

## Code signing

```bash
pulsar keygen
```

Writes `pulsar-private.pem` (mode 0600) and `pulsar-public.pem` in the current folder. Put the
public key in your app as `CodePushPublicKey` (iOS `Info.plist`, Android `strings.xml`). From then on
the device rejects any update not signed with the matching private key.

- `--private-key <file>` signs the release locally with that key.
- `PULSAR_SIGNING_KEY` does the same with the key itself in the environment, which suits CI.
- With neither, the CLI asks Pulsar to sign with the app's stored key. If Pulsar holds no key for
  the app, the release goes out unsigned and the CLI says so.

## Hermes bytecode

`pulsar release` compiles the bundle to Hermes bytecode the way your store build does: from an
unminified bundle, with the compiler in your `node_modules`. The app no longer parses the JavaScript
on every cold start, which is what makes low-end Android phones slow to open after an OTA.

- Hermes is on unless the project turns it off: `hermesEnabled=false` in `android/gradle.properties`,
  `enableHermes: false` in `android/app/build.gradle` (React Native 0.70 and older), or
  `:hermes_enabled => false` in `ios/Podfile`.
- `--no-hermes` releases JavaScript. `--hermes` compiles even when the project says otherwise.
- The compiler comes from your `node_modules` (`hermes-compiler/hermesc`,
  `react-native/sdks/hermesc` on React Native 0.82 and older, or `hermes-engine` on 0.68 and older).
  If it is missing the CLI stops and suggests `--no-hermes`; it never ships JavaScript in its place.

Bytecode only runs on a Hermes with the same bytecode version, and React Native upgrades change it
(React Native 0.82 and 0.83 use v96, 0.84 to 0.86 use v98). So every bytecode release also carries a JavaScript
copy of the same release, with the same assets:

- A build that reports the same bytecode version (SDK 1.9 or later) gets the bytecode. Until your
  store builds run SDK 1.9, most devices get the JavaScript copy. SDK 1.9 has no native changes over
  1.8, so a build on SDK 1.8 starts reporting once it installs an OTA built with 1.9.
- Every other build gets the JavaScript copy: older SDKs, other bytecode versions, JSC.
- Before uploading, the CLI prints how many active devices on `--target` report the matching
  version and get the bytecode; the rest get the JavaScript copy.
- The CLI checks that your Pulsar server can serve bytecode releases this way first, and stops if it can't.
- For private apps both builds are encrypted, and `--plain-copy-for-old-builds` uploads the
  JavaScript copy as the plain copy.
- Metro runs twice: minified for the JavaScript copy, the same kind of bundle earlier releases
  shipped, and unminified for the bytecode. Both builds carry the same assets.
- When the app has a signing key, both builds are signed. Each gets its own source map, so on apps
  without private bundles crash stacks map to your files whichever one a device runs.
- `--max-growth` compares bytecode with the last bytecode release and the JavaScript copy with the
  last JavaScript, so the first bytecode release does not trip it.
- Diffs are built for the bytecode build, including from the previous release's JavaScript copy.
- `pulsar history` tags these releases `[bytecode v96 + JS copy]`.
- Pulsar won't roll back to a bytecode release without its JavaScript copy, and on a deployment that
  needs approval the copy can't be added once the release is approved or rejected.

Limits: bytecode compresses less well than minified JavaScript, so a full download is larger (about
1.9 times for one app we measured). It doesn't hide your code: any client that doesn't report a
bytecode version gets the JavaScript copy, so the code is as readable as before, and the benefit is
the faster cold start. Bytecode on its own is harder to read, not unreadable: decompilers exist and
strings stay visible. It is not a way to hide anything from app review.

## Private bundles (encrypted releases)

When an app's Private bundles setting is Manual unlock or Auto unlock, `pulsar release` encrypts
the bundle, diff, manifest and source map before upload, so Pulsar stores and serves only ciphertext.
It is not protection against reverse engineering: the key ships inside your store build, so anyone
who unpacks the app can extract it and decrypt that app's releases. Full guide:
[usepulsar.dev/docs/private-bundles](https://usepulsar.dev/docs/private-bundles).

```bash
pulsar bundle-key create --app MyApp
```

Generates a key, writes `pulsar-bundle-key-MyApp.txt` (mode 0600, never overwrites an existing
file; `--out <file>` to choose the path), registers the key id with Pulsar and prints the
`Info.plist` / `strings.xml` snippets. Back the key up: Pulsar can't recover it, and builds that
carry only a lost key can't receive OTAs until a store build ships a new one.

The key string is `kid:base64key`, comma separated for several keys. The same string goes in
`PULSAR_BUNDLE_KEY` and in `CodePushBundleKeys` (SDK 1.8 or later):

```xml
<!-- iOS Info.plist -->
<key>CodePushBundleKeys</key><string>KID:BASE64KEY</string>

<!-- Android res/values/strings.xml -->
<string moduleConfig="true" name="CodePushBundleKeys">KID:BASE64KEY</string>
```

Releasing a private app needs the bundle key and a local signing key:

```bash
export PULSAR_BUNDLE_KEY="$(cat pulsar-bundle-key-MyApp.txt)"
export PULSAR_SIGNING_KEY="$(cat pulsar-private.pem)"
pulsar release MyApp Production --platform ios --target 1.4.0
```

- `--bundle-key <file>` reads the key string from a file instead of `PULSAR_BUNDLE_KEY`.
- `--plain-copy-for-old-builds` also uploads the signed, unencrypted zip of the same release, so
  builds that can't open the encrypted copy still get the fix. Pulsar can read that copy.
- `--plain` releases unencrypted on purpose while private bundles are on: every build gets it, and
  Pulsar can read it.
- `--only-older-builds` releases unencrypted only to builds that can't open private releases; builds
  holding the key keep their encrypted release.
- `pulsar history` tags releases `[private]`, `[private + plain copy]` and `[plain, older builds only]`.
- Each encrypted release prints its reach (devices that will get it, devices that stay on their
  current bundle). A mandatory encrypted release with no reach and no plain copy is blocked.
- The CLI warns when a key registered for the app is missing from the keys you gave it, and wraps
  each release for every key it is given, which is how you rotate.
- Older builds are never sent a release they can't open; they stay on their current bundle.

`pulsar changes --app MyApp --deployment Production --label v12` downloads that release's encrypted
manifests and source maps, unlocks them on your machine and prints what changed. The key never
leaves your machine.

## Migrating from RevoPush / code-push-server

`pulsar migrate` copies apps from any server that speaks the CodePush management API
(RevoPush, a self-hosted `microsoft/code-push-server`) into Pulsar:

```bash
pulsar migrate --from https://<your-codepush-server> --access-key <source access key> \
       [--apps MyApp-iOS,MyApp-Android] [--org "My Org"] [--platform ios|android] \
       [--releases latest|none] [--dry-run]
```

- Each source app becomes a Pulsar app in `--org` (optional when you belong to one org), or reuses
  the Pulsar app with the same name and platform. Deployments keep their names; existing ones are reused.
- The platform comes from the source app's `os`, or its name (`*-iOS`, `*-Android`). Pass
  `--platform` for apps named neither way.
- `--releases latest` (default) downloads each deployment's current release, re-hashes and signs it
  the way `pulsar release` does, and publishes it with the same target version, description,
  mandatory flag, rollout and disabled state. A release that can't be downloaded or unzipped is
  reported and skipped. Re-running is safe: a bundle already on the Pulsar deployment is not re-uploaded.
  A release that is already Hermes bytecode is skipped too, since it has no JavaScript copy for builds
  that can't run it: release it again from source with `pulsar release`.
- `--dry-run` reads both servers and prints the plan without writing anything to Pulsar.

The run ends with a table of source key → new Pulsar key per deployment. Devices keep checking the
old server until each app is rebuilt with its new key and Pulsar's URL:

```xml
<!-- iOS Info.plist -->
<key>CodePushDeploymentKey</key><string>NEW_PULSAR_KEY</string>
<key>CodePushServerURL</key><string>https://api.usepulsar.dev</string>

<!-- Android res/values/strings.xml -->
<string moduleConfig="true" name="CodePushDeploymentKey">NEW_PULSAR_KEY</string>
<string moduleConfig="true" name="CodePushServerUrl">https://api.usepulsar.dev</string>
```

## Use it from CI

Both env vars are all a GitHub Actions / GitLab CI job needs:

```yaml
- run: npm i -g @novacraft-engineering/pulsar-cli
- run: pulsar release MyApp Production --platform ios --target 1.4.0 --rollout 25
  env:
    PULSAR_API_URL: https://api.usepulsar.dev
    PULSAR_TOKEN: ${{ secrets.PULSAR_TOKEN }}
```

Add `PULSAR_SIGNING_KEY` to sign locally, and `PULSAR_BUNDLE_KEY` for apps with private bundles on.

Or connect the repo in the dashboard and fire a release for any commit without leaving the browser.

## Related

- [`@novacraft-engineering/pulsar-code-push`](https://github.com/Novacraft-Africa/pulsar-code-push) — the React Native client this CLI ships to
- [Pulsar vs CodePush vs RevoPush](https://usepulsar.dev/blog/codepush-vs-revopush-vs-pulsar)
- [How React Native OTA updates actually work](https://usepulsar.dev/blog/how-react-native-ota-updates-work)
- [Staged rollouts and instant rollback](https://usepulsar.dev/blog/staged-rollouts-instant-rollback-react-native)

## License

MIT © Novacraft Engineering
