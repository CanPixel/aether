# Code Signing and Notarization

ÆTHER currently ships **unsigned** on every platform. This document is the setup
guide for changing that.

There are two independent signing schemes here, and they are easy to confuse:

|                                                                 | Purpose                                             | Cost       | Status                         |
| --------------------------------------------------------------- | --------------------------------------------------- | ---------- | ------------------------------ |
| **OS code signing** (Apple Developer ID, Azure Trusted Signing) | Stops the OS blocking the _first install_           | ~$220/year | Not wired up — see below       |
| **Updater signing** (minisign)                                  | Lets the app verify an _update_ it downloads itself | Free       | Wired up, waiting on a keypair |

They are unrelated: the updater's minisign key is generated locally by the Tauri CLI
and has nothing to do with Apple or Microsoft. So [in-app
updates](#in-app-updates--minisign) can be turned on today, without waiting for the
paid certificates.

Until OS signing is done, see [Install](../README.md#install) for what users have to
do to open an unsigned build.

## Why it matters

An unsigned, un-notarized `.dmg` downloaded through a browser is quarantined by
macOS. The user does not get a "are you sure?" prompt they can click through — they
get **"ÆTHER is damaged and can't be opened. You should move it to the Bin."** That
message is indistinguishable from a malware warning, and it is the first thing a new
user sees.

On Windows, an unsigned NSIS installer triggers SmartScreen's "Windows protected
your PC — unknown publisher" interstitial, where the _Run anyway_ button is behind a
_More info_ link.

For a tool whose entire pitch is that it keeps your data on your machine, asking the
user to override their OS's security check is the wrong first impression.

## macOS — Developer ID + notarization

**Cost:** Apple Developer Program, $99/year.

1. **Enrol** at <https://developer.apple.com/programs/>. Individual enrolment is
   enough; it can take a day or two to be approved.
2. **Create a Developer ID Application certificate** in Certificates, Identifiers &
   Profiles. Note this is _Developer ID Application_, not _Mac App Distribution_ —
   the latter only works for the Mac App Store and will not help with direct
   downloads.
3. **Export it as a `.p12`** from Keychain Access (right-click the certificate →
   Export), set a password, then base64 it for CI:
   ```bash
   base64 -i certificate.p12 | pbcopy
   ```
4. **Create an App Store Connect API key** (Users and Access → Integrations → Keys)
   with the _Developer_ role. Download the `.p8` — Apple only lets you download it
   once. Record the Key ID and Issuer ID shown next to it.
5. **Add GitHub repository secrets:**

   | Secret                       | Value                                               |
   | ---------------------------- | --------------------------------------------------- |
   | `APPLE_CERTIFICATE`          | base64 of the `.p12`                                |
   | `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password                          |
   | `APPLE_SIGNING_IDENTITY`     | e.g. `Developer ID Application: Your Name (TEAMID)` |
   | `APPLE_API_KEY_ID`           | Key ID from step 4                                  |
   | `APPLE_API_ISSUER`           | Issuer ID from step 4                               |
   | `APPLE_API_KEY`              | base64 of the `.p8`                                 |

6. **Config changes.** In `src-tauri/tauri.conf.json`, under `bundle.macOS`, add a
   hardened-runtime entitlements file. Notarization rejects binaries without the
   hardened runtime, and llama.cpp's Metal path needs the JIT entitlement:

   ```xml
   <!-- src-tauri/entitlements.plist -->
   <key>com.apple.security.cs.allow-jit</key><true/>
   <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
   ```

   Tauri's bundler reads `APPLE_SIGNING_IDENTITY` and the `APPLE_API_*` variables
   directly, so the macOS CI job needs the secrets in `env:` and an import step for
   the certificate — it does not need a separate `notarytool` invocation.

7. **Verify** a built app before trusting the pipeline:
   ```bash
   codesign --verify --deep --strict --verbose=2 "ÆTHER.app"
   spctl --assess --type execute --verbose "ÆTHER.app"
   xcrun stapler validate "ÆTHER.app"
   ```
   `spctl` must report `accepted source=Notarized Developer ID`.

**Note on the DMG.** The installer is built by `scripts/make-styled-dmg.sh` via
`appdmg`, not by Tauri's bundler, so the `.dmg` itself needs signing and stapling as
a separate step after it is assembled — signing the `.app` alone is not enough.

## Windows — Azure Trusted Signing

**Cost:** roughly $10/month. The older route is an OV or EV certificate from a CA
(DigiCert, Sectigo) at a few hundred dollars a year; EV additionally requires a
hardware token, which does not work in CI without a cloud HSM. Azure Trusted Signing
is the cheaper and more CI-friendly option for a solo project, and it accrues
SmartScreen reputation against Microsoft's root rather than from zero.

1. Create an Azure account and a **Trusted Signing** account and certificate profile.
   Identity validation takes a few days for an individual.
2. Register an app in Entra ID, grant it the _Trusted Signing Certificate Profile
   Signer_ role, and record the tenant, client ID, and client secret.
3. Add `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`,
   `AZURE_ENDPOINT`, `AZURE_CODE_SIGNING_NAME`, `AZURE_CERT_PROFILE_NAME` as
   repository secrets.
4. Set `bundle.windows.signCommand` in `tauri.conf.json` to invoke the Trusted
   Signing CLI over `%1`. Tauri passes each artifact path through it.

Reputation is earned per-publisher over download volume, so expect SmartScreen to
keep warning for the first weeks even once signing works.

## Linux

No signing is required for `.deb` or AppImage — neither apt nor the AppImage
runtime enforces publisher identity by default. If ÆTHER is ever published through
Flathub, that has its own review and build process, and signing is handled there.

## In-app updates — minisign

This part **is** wired up. Settings → Updates offers _Install Update_ when a newer
release exists, downloads it, verifies its signature, and installs it in place. All
that is missing is a keypair, which is free and takes a minute.

Until the key exists nothing changes: builds are byte-identical to before, and the
Install button reports `unconfigured` — _"This build has no update signing key, so
ÆTHER cannot verify a download"_ — rather than fetching something it could not check.

### Turning it on

1. **Generate the keypair.** The password may be empty, but a real one is better —
   anyone with the private key can push an update to every ÆTHER install.

   ```bash
   bun run tauri signer generate -w ~/.tauri/aether-updater.key
   ```

   This prints a public key and writes the private key to that path. **Back both up
   somewhere durable.** Losing the private key means no existing install can ever be
   updated again — every user has to reinstall by hand.

2. **Commit the public key** into `src-tauri/tauri.conf.json` under
   `plugins.updater.pubkey`, replacing the empty placeholder. It is a public key;
   committing it is the intended usage.

3. **Add two repository secrets:**

   | Secret                               | Value                                     |
   | ------------------------------------ | ----------------------------------------- |
   | `TAURI_SIGNING_PRIVATE_KEY`          | contents of `~/.tauri/aether-updater.key` |
   | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the password from step 1                  |

   The moment `TAURI_SIGNING_PRIVATE_KEY` exists, the build jobs start producing
   signed updater artifacts and the release job publishes `latest.json`. Nothing else
   needs changing — see `.github/actions/updater-flags`.

4. **Verify** after the next tagged release:
   ```bash
   curl -sL https://github.com/CanPixel/aether/releases/latest/download/latest.json | jq .
   ```
   It should list `darwin-aarch64`, `darwin-x86_64`, `windows-x86_64`, and
   `linux-x86_64`, each with a non-empty `signature` and a URL pinned to the release
   tag. The two macOS entries intentionally share the universal updater archive.

### What updates, and what does not

| Install                        | Self-updates | Why                                                                                 |
| ------------------------------ | ------------ | ----------------------------------------------------------------------------------- |
| macOS `.dmg` → `/Applications` | Yes          | Replaces the `.app` bundle in place                                                 |
| Windows `-setup.exe`           | Yes          | Re-runs the NSIS installer silently                                                 |
| Linux AppImage                 | Yes          | Rewrites the AppImage file                                                          |
| Linux `.deb` / `.rpm`          | **No**       | Owned by the package manager; ÆTHER reports `unsupported` rather than corrupting it |
| Linux ARM64                    | **No**       | Only a `.deb` is published, so there is no signed artifact                          |
| Android                        | **No**       | Store-managed                                                                       |

### Two things worth knowing

**`createUpdaterArtifacts` is a hard build error without the private key.** That is
why it lives in `src-tauri/tauri.updater.conf.json` and is merged in only when the
secret exists, instead of sitting in the main config — otherwise every branch push
would fail until the key was created.

**Updates may sidestep the quarantine problem.** Tauri's updater downloads and
extracts the bundle itself rather than going through a browser, so it should not
attach `com.apple.quarantine` — meaning the `xattr` dance in the README would apply
only to the _first_ install, not to subsequent updates. This follows from how
quarantine is applied and has **not been verified against a real signed release**;
confirm it before relying on it.

## Order of work

1. **Updater keypair first.** It is free, takes a minute, and is the only item here
   that improves anything today — without it, a security fix reaches only users who
   happen to re-download by hand.
2. macOS Developer ID second. It is the only platform where the current state is a
   hard block rather than a bypassable warning, and it is the platform ÆTHER is
   developed on.
3. Windows last. SmartScreen is unpleasant but clickable, and reputation takes
   weeks to build regardless of when you start.
