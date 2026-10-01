# The desktop app's signing certificate

The `edge-build` job in `.github/workflows/ci.yml` signs `Hercule.app` with one self-signed code-signing certificate, the same one for every build. This note explains why, and how to make the certificate and store it where only that job can read it.

## Why a certificate and not an ad hoc signature

The desktop app keeps its sign-in token encrypted with a key that `safeStorage` holds in the Keychain. The Keychain gives that key only to an app that meets the app's **designated requirement**, which `codesign` writes into the signature (spec 17, §Auth and the token).

- An ad hoc signature has the requirement `cdhash H"..."`: the hash of that one build. The next build has a different hash, so the Keychain treats it as a different app. After an update the user signs in again.
- A certificate signature has the requirement `identifier "..." and certificate leaf = H"..."`: the app's signing identifier, which is its bundle identifier, and the hash of the certificate. Both stay the same from build to build, so the Keychain keeps trusting the app after an update.

An Apple Developer ID certificate replaces this one later, together with notarization. Until then, Gatekeeper does not trust the self-signed certificate, but a file that `install.sh` downloads with `curl` carries no quarantine flag, so the app opens.

The `hercule` binary is not signed with the certificate. It stays ad hoc signed, because the controller reads its master key through Apple's `security` tool. The Keychain item trusts that tool, not the binary, so a new binary changes nothing.

## Make the certificate

On a Mac:

1. Open Keychain Access, then **Keychain Access > Certificate Assistant > Create a Certificate**.
2. Set:
   - **Name:** `Hercule Desktop Signing`
   - **Identity Type:** Self Signed Root
   - **Certificate Type:** Code Signing
   - Tick **Let me override defaults**.
3. Continue to **Validity Period (days)** and set `7300` (20 years). Keep the other defaults.

The validity is long on purpose. A new certificate has a new hash, so it changes the app's designated requirement, and every user signs in once more after the first update signed with it.

## Store it in the `desktop-signing` environment

Anyone with the certificate's private key can sign an app that the Keychain trusts with the desktop app's token key (spec 13, section 12). So the key is kept in a GitHub environment that only `main` can use, not in the repository's secrets, which a workflow on any branch can read.

1. Create the environment, and allow only `main` to deploy to it. Do this before the first push to `main` that runs `edge-build`: a job that names an environment which does not exist creates it, with no rule on which branches may use it.

   ```sh
   gh api --method PUT repos/theagenticage/hercule/environments/desktop-signing \
     --input - <<'EOF'
   {"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
   EOF
   gh api --method POST repos/theagenticage/hercule/environments/desktop-signing/deployment-branch-policies \
     -f name=main -f type=branch
   ```

   A later release built from a tag, such as a stable or a beta one, is allowed by adding its tag pattern the same way, with `type=tag`.

2. In Keychain Access, open **My Certificates** and find `Hercule Desktop Signing`. Expand it so the private key shows under it.
3. Select the certificate and its private key, then **File > Export Items**, and save as `cert.p12`. Give it a strong password: a long random one from a password manager.
4. Store the file and its password in the environment's secrets:

   ```sh
   base64 -i cert.p12 | gh secret set SIGNING_CERTIFICATE --env desktop-signing --repo theagenticage/hercule
   gh secret set SIGNING_CERTIFICATE_PASSWORD --env desktop-signing --repo theagenticage/hercule
   ```

   The second command asks for the password.

5. Delete `cert.p12`, and delete the identity and its private key from the login keychain. The key must not stay on a Mac that builds the app: electron-builder signs with the first code-signing identity it finds in the keychain, so a local build would carry the release signature. The secrets are then the only copy, and GitHub never shows them again, so a lost certificate is replaced, not recovered.

`edge-build` fails before it builds the app when either secret is empty. It does not fall back to an ad hoc signature, because every update would then sign the user out.

## On CI

Before it builds the app, `edge-build`:

1. imports the certificate into a keychain it makes for the job, with the private key marked as not exportable, so the build tools that run after it can sign with the key but cannot copy it;
2. marks the certificate as trusted for code signing on its runner, because macOS does not trust a self-signed certificate, and electron-builder signs only with an identity that `security find-identity -v` lists as valid;
3. names the identity in `CSC_NAME`, so electron-builder signs with it.

electron-builder can import a certificate itself, from `CSC_LINK` and `CSC_KEY_PASSWORD`, but version 26 then passes the certificate's password to `security set-key-partition-list`, which needs the keychain's, and the build fails. So the secrets have names of their own, and electron-builder never sees them.

The runner is thrown away after the job, with its keychain and trust settings. Users' Macs never need to trust the certificate: the Keychain compares the hash in the designated requirement, not trust settings.

## When the certificate expires or is replaced

- An expired certificate is no longer a valid identity, so `edge-build` fails before anything is published. Make the new certificate before that day.
- Any new certificate, including the Developer ID that replaces this one, changes the designated requirement. Every user signs in once more after the first update signed with it. After that, updates keep the sign-in again.
- To replace it, make a new certificate as above and overwrite the two secrets. The next push to `main` publishes an app signed with it.
