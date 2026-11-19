# ReGBY Web: Security & Attack-Vector Review (second pass)

| | |
|---|---|
| **Target** | `regby-web` v1.5.1 (`regby-web-main.zip`), deployed at https://regby.nostr.box/ |
| **Reviewer model** | Claude Opus 5.5 (model ID `claude-opus-5-5`) |
| **Earlier pass** | Claude Sonnet 5.5, same day: `regby-web-security-review.md` |
| **Date** | 26 October 2026 |
| **Type** | Static source review plus a lockfile dependency audit. Read-only: no source changes, commits or pushes. |
| **Prepared for** | ZenTen / Formless Labs developers |

> **Independence note:** this pass ran in the same session as the Sonnet 5.5 pass, so it was not blind to those findings. Every earlier finding was re-checked against the source rather than copied, and section 6 lists where the two passes differ.

## 1. Verdict

| Area | Opus 5.5 | Sonnet 5.5 |
|---|---|---|
| The app code itself | **8 / 10** | 8 / 10 |
| The system as deployed today (protocol, hosting, build pipeline) | **4 / 10** | 5 / 10 |

The client code is careful: no injection paths, secrets kept out of React state, key material wiped, and the SSH unlock done in a worker that is thrown away afterwards. The weak points are around it:

- **The protocol** sends the 8-digit code, which is the only thing needed to fetch the merchant's text, in a plaintext tag on every event.
- **The build pipeline** runs npm, unpinned release plugins, a GitHub write token and the production deploy key all in one job on one runner.
- **The hosting** sends no security headers from the repo's config.

This matters more than usual because the SSH login takes the user's encrypted key file and passphrase. The UI requires a subaccount, so the session identity is never the user's primary npub. But the key file and passphrase unlock the master seed, which is the same root `chat` and `usdt-pay` use. A tampered copy of this page could therefore derive the user's primary identity. Anything that lets an attacker change the JavaScript served from `regby.nostr.box` is the highest-impact risk.

Estimated score after fixes 1 to 6 in section 4: about **7 / 10** as deployed. Reaching 8 or above needs a move from NIP-04 to NIP-44 and an independent penetration test.

## 2. Scope, method and limits

**Reviewed:** `index.html`, `vite.config.ts`, `public/.htaccess`, `.github/workflows/deploy.yml`, `release.config.cjs`, `package.json` and `package-lock.json`, `.env.production`, `.gitignore`, `AGENTS.md`, `README.md`, `docs/build-summary.md`, and all of `src/`: `App.tsx`, the 6 screens, components, `services/{keys,regby,ssh,worker}`, `lib`, `config`.

**Dependency audit:** `npm audit --package-lock-only` against the committed lockfile, in an isolated directory. Nothing was installed and no repo scripts were run.

**Not done, and not covered by any score:**
- No dynamic testing and no penetration test. The test suite was not executed.
- Live response headers were not checked; the review environment could not reach the site. Header claims rest on `public/.htaccess` and `index.html`. **Assumption:** the host may add headers elsewhere, for example in the Apache vhost or cPanel.
- The broker (`regby-middleware`), the three relays and the hosting account are out of scope. Anything about their behaviour is marked as unverified.
- Repository secrets (`DEPLOY_*`, `MATRIX_ACCESS_TOKEN`) are referenced by name only. No secret values appear in the repo.

**Confidence labels:** High means verified directly in source. Medium means it depends on something I could not observe. Low means it depends on a component outside the repo.

## 3. Findings

Severity is my judgement of impact times likelihood for this app. None of these is a confirmed exploit. **NEW** marks findings the Sonnet pass did not report.

| ID | Severity | Finding | Confidence |
|---|---|---|---|
| O1 | **High** | Build, release and deploy share one job: npm code, a write token and the deploy key on one runner (3.1) | High |
| O2 | **Medium** | **NEW** Release plugins installed at run time by major version, outside the lockfile (3.2) | High |
| O3 | **Medium** | **NEW** The 8-digit code, and the merchant/customer pairing, travel in plaintext tags (3.3) | High (exposure) / Medium (exploitability) |
| O4 | **Medium** | No HTTP security headers; CSP delivered by meta tag only, so the page can be framed (3.4) | Medium |
| O5 | **Medium** | NIP-04 messaging; the broker is a full-trust party (3.5) | High |
| O6 | **Medium (unverified)** | **NEW** Brute-force resistance of redeem depends entirely on the broker (3.6) | Low |
| O7 | **Low-Medium** | `connect-src wss:` allows any websocket host (3.7) | High |
| O8 | **Low-Medium** | No Dependabot, CodeQL or `npm audit` in CI (3.8) | High |
| O9 | **Low** | **NEW** Copy hands back hidden and bidi characters the display removed (3.9) | High |
| O10 | **Low** | bcrypt rounds uncapped; Back disabled while unlocking (3.10) | High |
| O11 | **Low** | 3 dev-only dependency alerts (vitest, tinypool) (3.11) | High |
| O12 | **Info** | Relays that refuse AUTH are still used (3.12) | High |
| O13 | **Info** | JavaScript strings (PEM, passphrase) cannot be wiped (3.13) | High |

### 3.1 O1: One job holds npm code, a write token and the deploy key

**Where:** `.github/workflows/deploy.yml:36-39` (job permissions), `:46-50` (checkout, token persisted), `:61` (`npm ci`), `:67` (`npm test`), `:96` (`npm run build`), `:109` (deploy key written), `:176` (deploy key removed).

**What:** The single `release` job has `contents: write`, `issues: write` and `pull-requests: write`, and `actions/checkout` keeps the token on disk for the git plugin. In that same job, on the same runner, it:
1. installs all npm packages with lifecycle scripts enabled (`npm ci`, no `--ignore-scripts`),
2. runs the tests and the build, which execute dependency code,
3. writes the SFTP deploy key to `~/.ssh/deploy_key`,
4. uploads `dist/` to the live site.

The workflow comments explain the single-job choice: semantic-release needs push access even in a dry run, and a second job could check out a stale `main`.

**Why "key written after build" is not isolation:** the Sonnet pass called this good. It is still the same runner and the same user. Code run during `npm ci`, the tests or the build can start a background process that waits for `~/.ssh/deploy_key` to appear, or that edits `dist/` after the build step finishes. Removing the key afterwards does not undo a copy already taken.

**Attack path:** A compromised dependency or action (in `npm ci`, the tests, the build, or the plugins in O2) can:
- push to `main` with the persisted token;
- change `dist/` before upload, or steal the deploy key and upload later. Either way, users who paste SSH keys and passphrases get modified JavaScript.

**Mitigating factors:**
- Runs only on pushes to `main` and `workflow_dispatch`, never on pull requests, so outside contributors cannot trigger it.
- Committed lockfile and `npm ci`.
- 45 production packages.
- `known_hosts` comes from a secret, not `ssh-keyscan`.
- The exact deployed bundle is attached to each GitHub Release (`:191-193`). That allows a later comparison with the live site, but the bundle is produced by the same job, so it cannot reveal a poisoned build.

### 3.2 O2 (NEW): Release plugins installed unpinned at run time

**Where:** `.github/workflows/deploy.yml:79-81` (dry run) and `:202-204` (publish).

**What:** `cycjimmy/semantic-release-action` is correctly SHA-pinned, but its `extra_plugins` are `@semantic-release/changelog@6` and `@semantic-release/git@10`. The action installs these from npm at run time, at whatever the latest 6.x and 10.x are, outside `package-lock.json`. Both steps run with `GITHUB_TOKEN` (write). The dry run happens before the build, so a malicious plugin version would also run before the deploy key appears, which ties into O1.

**Fix:** Add both plugins (and `semantic-release` itself) as exact-pinned `devDependencies` so they come from the lockfile, and run semantic-release from `npx` against the installed copy. Alternatively pin `extra_plugins` to exact versions (`@semantic-release/changelog@6.0.3`, and so on). Exact versions still are not integrity-checked, so the lockfile route is better.

### 3.3 O3 (NEW): The code and the pairing travel in plaintext tags

**Where:** `AGENTS.md:14` ("Every event about a code carries it as `["regby_code", <code>]`"); `src/services/regby/client.ts:163` (redeem request adds the tag); `protocol.ts:108-122` (the broker sets it on its replies, and the client checks it); `client.ts:136` and `:168` (`to` and `from` pubkey tags).

**What:**
- **The code is in plaintext.** The redeem request encrypts the code in the message body with NIP-04, but then repeats it in a plaintext `regby_code` tag. Per `AGENTS.md`, the broker's replies carry it too, including the mint reply that hands the merchant a fresh code. The code is the only credential needed to fetch the merchant's text, so it is effectively sent in the clear.
- **The pairing is in plaintext.** The `from` and `to` tags name merchant and customer pubkeys in plaintext, so whoever reads the events sees who paired with whom. NIP-40 expiry is set to about 72 hours, so the events stay on the relays for up to that long.

**Who can read them:** The relays return an empty EOSE to unauthenticated reads (`docs/build-summary.md`), so a random third party probably cannot read the events. That is an assumption; I could not verify the relays' read rules. Readers therefore are at least the operators of `dm1.zentext.me`, `dm2.nostr.box` and `dm3.npub.cx`, plus anyone who compromises one of them, plus anyone who can satisfy a relay's read rules for these events.

**Attack path:** A party reading a relay sees a freshly minted code and sends its own redeem within the 60-second life of the code. It receives the merchant's text, and the real customer gets "already used". The merchant's screen shows "Redeemed by" a stranger's npub, so the theft is visible, but only after the fact.

**Fix:** Broker and client change. Stop putting the code in tags; correlate replies by the request's event id (already done with the `#e` filter) and keep the code only inside the encrypted body. Hashing the code in the tag does **not** help: 10⁸ codes can be hashed in well under a second. Move pairing pubkeys into the encrypted body too, if the broker does not need them for routing.

### 3.4 O4: No HTTP security headers; CSP is meta-only

**Where:** `public/.htaccess:8-18` sets cache headers only. The CSP is at `index.html:11-14`, and `no-referrer` at `:15`.

**What:** The repo's config sends no `Strict-Transport-Security`, `X-Frame-Options`, `X-Content-Type-Options` or `Permissions-Policy`. Browsers ignore `frame-ancestors` in a meta CSP, and `docs/build-summary.md` notes it was removed for that reason. So nothing in the repo stops the page from being framed.

**Attack path:**
- **Clickjacking:** another site frames ReGBY under decoy UI and steers a click (Paste SSH Key, Login with Signer, Generate Code).
- **Downgrade:** without HSTS, a first visit over plain HTTP can be downgraded or intercepted.

**Confidence:** Medium. The host may add headers outside the repo; check with `curl -I https://regby.nostr.box/`.

### 3.5 O5: NIP-04 messaging and broker trust

**Where:** `src/services/keys/signer.ts:9,29-30,53-66`; `src/services/regby/client.ts:193-196,271-277`.

**What:**
- **NIP-04 is deprecated.** It has no authentication of the encrypted content and no length padding, so the ciphertext length reveals the plaintext length.
- **The broker sees and controls everything.** It decrypts every merchant text, decides which text a code returns, and asserts the `from` pubkey the customer sees ("From npub…").
- **Replies are pinned correctly.** The client only accepts replies from the broker's key and tied to the request (`client.ts:241-248`). But the broker key is public (`.env.production`), so a compromised broker key or server can read all content and substitute what customers see.

**Fix:** Plan a move to NIP-44, which needs a broker change, and publish a short user-facing note on what the broker and relays can see.

### 3.6 O6 (NEW, unverified): Brute-force resistance lives in the broker

**What:** A code is 8 digits (10⁸ values) and lives 60 seconds (`config/regby.ts:30,34`). The client redeems automatically on the eighth digit and has no throttle, but an attacker would use their own client anyway. The protocol has a `regby_code_locked` failure (`protocol.ts:33`). Its trigger is not visible here, and a per-code lock does not stop guesses spread across many codes.

**Rough risk:** with *N* live codes and *G* guesses per minute, the chance of hitting some live code each minute is about *N × G / 10⁸*. For example, 100 live codes and 100,000 guesses a minute (spread over many throwaway keys) gives about 10% per minute.

**Ask the broker side:** Are there per-pubkey and global caps on failed redeems? Is the cap enforced before decryption? Do relays rate-limit kind 4 writes per key or IP?

### 3.7 O7: `connect-src wss:` allows any websocket host

**Where:** `index.html:13`.

**What:** The rest of the CSP is strict (`script-src 'self'`, `base-uri 'none'`, `form-action 'none'`, `worker-src 'self'`). The `wss:` wildcard means a future script injection could open a websocket to any host to send data out. The app needs only the three relays in `src/config/regby.ts:18-22`. There is no injection path today (section 5), so this is defence in depth.

### 3.8 O8: No automated supply-chain checks

**Where:** `.github/` contains only the deploy workflow. There is no Dependabot config, no CodeQL, no secret scanning, and no `npm audit` step. `package.json` uses caret ranges, which is fine with the lockfile but means upgrades should be reviewed.

### 3.9 O9 (NEW): Copy brings back hidden characters

**Where:** `src/screens/CustomerContentScreen.tsx:21` (`displayableContent`) and `:36` (`CopyButton text={content}`).

**What:** The screen strips zero-width, control and bidi-override characters for display, shows a notice when it did, and then copies the **original** text. If the shared text is an address, a payment reference or a command (plausible for a usdt-pay sibling app), the pasted copy can render differently from what the customer just read. The notice ("Copy keeps the original") helps, but most users will not act on it.

**Fix:** Copy the displayed (cleaned) text by default, and offer "Copy original" only when hidden characters were found.

### 3.10 O10: bcrypt rounds uncapped; Back disabled while unlocking

**Where:** `src/services/ssh/openssh.ts:127` (`readUInt32()`, no upper bound); `src/screens/SshKeyScreen.tsx:178` (`backDisabled={busy}`).

**What:** A key file with a huge round count makes the unlock run for a very long time. The worker keeps the page responsive and the screen shows an estimate, but the user cannot press Back, so the only way out is closing the tab. Uploaded files are capped at 64 KiB; pasted text is not.

**Impact:** Self-inflicted denial of service only; the user has to load the hostile key themselves.

**Fix:** Refuse round counts far above OpenSSH's default of 16 (for example more than 1024) with a clear error, and keep Back enabled during unlock (`cancelSshLogin()` already terminates the worker).

### 3.11 O11: Dev-only dependency alerts

`npm audit` result: **0 vulnerabilities in production dependencies**; 3 in dev dependencies.

| Package (locked) | Advisories | Notes |
|---|---|---|
| `vitest` 3.2.7 and `@vitest/mocker` | GHSA-82fw-gwwq-j7x9, GHSA-qxg6-89mg-rqv8 | Affect Vitest's server mock registration; CI runs `vitest run`. |
| `tinypool` 1.1.1 | GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr | Prototype-pollution gadgets needing attacker control of worker options. The "critical" label overstates the practical risk here. |

None of these ship in the bundle. They matter because tests run inside the privileged job (O1). The suggested fix is a vitest major upgrade (npm reports 5.0.5); test it before merging.

### 3.12 O12 (info): Relays that refuse AUTH are still used

**Where:** `client.ts:297-311`.

**What:** The client tries NIP-42 AUTH on each relay. Any error other than "no challenge" (a refusal, or the 15-second timeout), and running out of the 10 retries, all leave the relay in use. Because these relays return nothing to unauthenticated reads, the practical effect is a missed reply (availability), not a confidentiality loss.

### 3.13 O13 (info): Secrets in JavaScript strings

The PEM and passphrase are immutable strings and cannot be zeroed. The code does what it can: it reads them from the DOM at submit, never stores them in React state, clears the fields on unmount, and terminates the worker after every login so its copies are dropped. Key bytes are wiped (`bcrypt.ts`, `ssh/index.ts`, `nip06.ts`, `subaccount.ts`). Nothing to fix; it is a browser limit.

## 4. Recommended fixes (priority order)

| # | Fix | Closes | Effort |
|---|---|---|---|
| 1 | **Split the pipeline.** Job A: semantic-release dry run only (needs write). Job B: check out the exact `github.sha`, run `npm ci --ignore-scripts`, test and build with `contents: read` and no secrets, then upload `dist/` as an artifact. Job C: download the artifact, deploy with the SFTP key, publish the release. Checking out `github.sha` in each job avoids the stale-checkout race the workflow comment worries about. | O1 | Medium |
| 2 | **Pin everything.** Move the semantic-release plugins into exact-pinned `devDependencies` (lockfile). Pin `actions/checkout` and `actions/setup-node` by commit SHA. | O2, O1 | Small |
| 3 | **Take the code out of the tags.** Broker and client change: correlate by event id, keep the code and the pairing pubkeys inside the encrypted body. | O3 | Medium |
| 4 | **Prove redeem rate limits.** Confirm or add per-pubkey and global caps on failed redeems in the broker, and write-rate limits on the relays. Consider longer codes if the caps are loose. | O6 | Small to medium |
| 5 | **Send real security headers** from the vhost or `.htaccess`: `Strict-Transport-Security`, `Content-Security-Policy` with `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Permissions-Policy`. Keep the meta CSP as a fallback. | O4 | Small |
| 6 | **Narrow `connect-src`** to `'self' wss://dm1.zentext.me wss://dm2.nostr.box wss://dm3.npub.cx` (ideally generated from `REGBY_RELAYS`). **Cap bcrypt rounds** and keep Back enabled during unlock. | O7, O10 | Small |
| 7 | Turn on Dependabot (npm and GitHub Actions), CodeQL and an `npm audit --omit=dev` step; upgrade vitest. | O8, O11 | Small |
| 8 | Copy the cleaned text by default; offer "Copy original" separately. | O9 | Small |
| 9 | Plan the NIP-44 migration and publish a "what the broker and relays can see" note. | O5 | Medium |
| 10 | Add a scheduled check that hashes the live site's files and compares them with the release tarball, so server-side tampering is caught without waiting for a user. | O1 | Small |

## 5. What was checked and found sound

- **No injection sinks.** No `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `eval`, `new Function`, `document.write` or `window.open` in `src/`. The only `postMessage` use is the same-origin key worker.
- **Untrusted text shown as plain text.** Merchant content is a React text node, with hidden and bidi characters stripped for display (`protocol.ts:157-166`). Input limits: 2048 characters in the compose screen, 4096 characters and 4 KB encrypted on the wire, and a size bound before decrypting replies.
- **No browser storage or tracking.** No `localStorage`, `sessionStorage`, IndexedDB or cookies. The session is memory-only; a reload signs out. `no-referrer` is set, there are no analytics, and the QR is drawn locally.
- **Key handling.**
  - Unencrypted keys are refused.
  - Only `bcrypt` with `aes256-ctr` is accepted.
  - The wrong-passphrase check uses OpenSSH's check bytes.
  - The header public key must match the decrypted seed, which stops a crafted file naming one key while unlocking another.
  - Passphrase length is counted in UTF-8 bytes.
  - Key material is wiped at each step.
  - A subaccount is required, so the session never runs as the primary npub.
- **Signer safety.** Extension signatures are re-verified against the extension's pubkey. `dispose` wipes the local key on sign-out.
- **Reply handling.** The subscription opens before publishing. Replies are pinned to the broker's pubkey and the request's event id. The reply's intent decides success, never its content.
- **CSP content.** `script-src 'self'`, `base-uri 'none'`, `form-action 'none'`, `worker-src 'self'`, no third-party scripts or fonts.
- **Clipboard and code entry.** Paste happens only when the user taps it. Page-level key and paste listeners accept digits only and ignore other fields.
- **CI basics.**
  - Triggered only by pushes to `main` and manual dispatch, never by pull requests.
  - Third-party actions are SHA-pinned.
  - `known_hosts` comes from a secret.
  - The deploy key is removed with `if: always()`.
  - The Matrix notify job runs with `permissions: {}`.
  - The exact deployed bundle is attached to each release.
- **Repo hygiene.**
  - `.env.production` holds only the public broker pubkey.
  - `*.pem` and `id_ed25519*` are git-ignored.
  - The fixture keys in `src/services/ssh/__fixtures__/` are documented as throwaway keys copied from `chat`. Only their headers and sizes were inspected.

## 6. Differences from the Sonnet 5.5 pass

| Topic | Sonnet 5.5 | Opus 5.5 |
|---|---|---|
| Score as deployed | 5 / 10 | 4 / 10 |
| Plaintext `regby_code` and pairing tags | Not reported | O3, Medium |
| Unpinned semantic-release plugins | Not reported | O2, Medium |
| Deploy key "written after build" | Described as good | Not a real boundary: same runner (O1); O1 raised to High |
| Redeem brute force | Listed as an open question | O6, Medium (unverified), with a rough risk estimate |
| Copy keeps hidden characters | Not reported | O9, Low |
| Verifiable build | Suggested as new work | Partly exists (release tarball); added an automated comparison (fix 10) |
| "Primary identity" wording | User may log in with primary identity | Subaccount is required, but the typed key file and passphrase still unlock the master seed |
| No pull-request trigger | Not noted | Listed as a strength |
| AUTH fallback | Fallback after a 15 s timeout | Also on any refusal and after 10 retries; availability impact only |

All other Sonnet findings were confirmed against the source: headers, `connect-src`, NIP-04, uncapped rounds with Back disabled, and the dependency audit.

## 7. Open items for the developer to confirm

1. What response headers does `regby.nostr.box` send today?
2. What are the relays' read rules for kind 4? Who besides the author and the `p`-tagged recipient can read a given event?
3. Does the broker cap failed redeems per pubkey and overall? What triggers `regby_code_locked`?
4. Does the broker need the `regby_code`, `from` and `to` tags in plaintext, or can they move into the encrypted body?
5. Is the SFTP account limited to the web root, and is the deploy key used only for this site?
6. Were any of the fixture keys ever used for a real identity?

## 8. Disclaimer

This is a judgement-based static review by an AI model (Claude Opus 5.5). It is not a certification and not a substitute for an independent penetration test. Scores show where the work is, not a guarantee of safety.
