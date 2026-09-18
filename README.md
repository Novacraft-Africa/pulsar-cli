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
       [--rollout 25] [--mandatory] [--disabled] [--devices id1,id2,...] [--description "fix crash"]

pulsar promote <app> <from> <to> [--rollout 100]
pulsar rollback <app> <deployment>

pulsar deployment ls <app>            # list deployments + keys
pulsar deployment add <app> <name>    # create a new deployment (e.g. QA)
pulsar history <app> <deployment>     # release history
pulsar patch <app> <deployment> <label> [--rollout N] [--mandatory] [--disable] [--enable] [--devices id1,id2,...]
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

## Use it from CI

Both env vars are all a GitHub Actions / GitLab CI job needs:

```yaml
- run: npm i -g @novacraft-engineering/pulsar-cli
- run: pulsar release MyApp Production --platform ios --target 1.4.0 --rollout 25
  env:
    PULSAR_API_URL: https://api.usepulsar.dev
    PULSAR_TOKEN: ${{ secrets.PULSAR_TOKEN }}
```

Or connect the repo in the dashboard and fire a release for any commit without leaving the browser.

## Related

- [`@novacraft-engineering/pulsar-code-push`](https://github.com/Novacraft-Africa/pulsar-code-push) — the React Native client this CLI ships to
- [Pulsar vs CodePush vs RevoPush](https://usepulsar.dev/blog/codepush-vs-revopush-vs-pulsar)
- [How React Native OTA updates actually work](https://usepulsar.dev/blog/how-react-native-ota-updates-work)
- [Staged rollouts and instant rollback](https://usepulsar.dev/blog/staged-rollouts-instant-rollback-react-native)

## License

MIT © Novacraft Engineering
