# Blog content accuracy audit — 2026-09-21

Every published post (190) was audited for fabricated APIs and false technical
claims: 148 code-bearing posts against primary sources (man pages, kernel
headers, docs.rs, pkg.go.dev, vendor docs), and 42 prose-only posts against
standards bodies.

**Result: ~115 confirmed errors across ~60 posts.** Most are not typos. The
generator invented identifiers that do not exist, and asserted behaviour that
the named mechanism cannot perform.

## Why this exists

The same LLM pipeline that truncated 65 posts (fixed in #348/#349/#350) also
fabricated technical detail. Truncation was visible; this is not. A post that
confidently documents `MOUNT_ATTR_IMMUTABLE` reads exactly like one that
documents `MOUNT_ATTR_RDONLY`.

Two failure shapes recur:

1. **A real symbol with a plausible affix bolted on** — `LANDLOCK_ACCESS_FS_REFER_FILES`
   for `..._REFER`, `LANDLOCK_RULE_TYPE_PATH_BENEATH` for `LANDLOCK_RULE_PATH_BENEATH`,
   `sk-ecdsa` for `ecdsa-sk`, `cert-to-efi-siglist` for `cert-to-efi-sig-list`,
   `admission.k88s.gatekeeper.sh` for `admission.k8s.gatekeeper.sh`.
2. **A mechanism credited with power it does not have** — kprobes "blocking" a
   syscall, seccomp filtering by pathname, a tracepoint vetoing an operation.
   These are the dangerous ones: the code runs, reports success, and enforces
   nothing.

## Severity

| | Meaning | Count (approx.) |
|---|---|---|
| **CENTRAL** | The post's main demo or claim is wrong. A reader following it gets a broken or insecure result. | ~55 |
| **MODERATE** | A supporting claim is wrong; the main thrust survives. | ~20 |
| **COSMETIC** | Illustrative text, names, or an unused line. | ~40 |

Counts are approximate because several posts carry multiple findings.

---

## Tier 1 — security-inverting

These tell a reader a control is in place when it is not. Highest priority
regardless of what else gets fixed.

- **`2026-04-15` Vault/Terraform JIT access** — `default_sts_ttl`/`max_sts_ttl`
  apply only to `assumed_role`/`federation_token`, not the `credential_type =
  "iam_user"` the post uses. A reader following it gets AWS admin keys living
  ~32 days, not the promised 1 hour. The post's entire premise inverted.
- **`2026-07-06` AI red-teaming** — IAM `Deny` + `StringNotEquals` on
  `Environment = Production` denies everything *except* Production: the exact
  inverse of confining a red-team agent to a sandbox.
- **`2026-06-14` seccomp-bpf sandboxes** — claims seccomp can "restrict `openat`
  to specific paths". It structurally cannot: the filter only sees register
  values, never the memory a pointer references. A reader ships a sandbox that
  does not do what they believe.
- **`2026-04-22` + `2026-08-15` eBPF blocking** — both use a plain kprobe and a
  return value to "block" a syscall. Entry kprobes cannot alter execution;
  that needs `bpf_override_return()`. Both posts print a "policy active"
  message while blocking nothing.
- **`2026-04-27` + `2026-05-14` Cilium policies** — `toFQDNs`/`toEndpoints` and
  `toPorts` are listed as separate egress items, so they OR instead of AND.
  Both policies are far more permissive than the text claims.
- **`2026-05-26` eBPF network policy** — the `cursor_advance` macro double-scales
  pointer arithmetic (`ptr += n` already scales by `sizeof(*ptr)`), so offsets
  jump 196 bytes instead of 14; bounds checks trip and the program falls
  through to *pass* traffic.
- **`2026-05-06` OPA/GitOps gates** — `opa eval` without `--fail` exits 0
  regardless of result, and queries a package the post never defines. Neither
  the pre-commit hook nor the CI gate ever blocks anything.
- **`2026-05-09` incident response** — claims `update_login_profile(...,
  PasswordResetRequired=True)` "locks" an IAM user. It only forces a password
  change at next sign-in; it does not invalidate the current password or kill
  active sessions.

## Tier 2 — the post's main artifact does not work

Non-exhaustive; see the per-post list below.

- **`2026-05-27` custom LSM** — built on `struct security_operations` +
  `lsm_register_security()`, removed from the kernel in 2.6.24 (2008)
  *specifically* to stop runtime-loadable LSMs. Nothing in the tutorial can
  work on any supported kernel. The worst single post in the corpus.
- **`2026-08-27` mount_setattr** — `MOUNT_ATTR_IMMUTABLE` does not exist, and
  the post gives the syscall 4 parameters when it takes 5.
- **`2026-09-05` memfd_secret** — `MFD_CLOEXEC` is undefined for this syscall
  (only `O_CLOEXEC` is accepted), `MFD_SECRET_EXEC` is invented, and
  `__NR_memfd_secret` is given as 461 when it is 447 on x86_64.
- **`2026-09-17` pkey_alloc** — `SYS_pkey_set`/`SYS_pkey_get` are not syscalls.
  They are glibc wrappers executing `WRPKRU`/`RDPKRU` in userspace — which is
  the entire performance point of PKU.
- **`2026-09-11` Landlock** — `struct landlock_ruleset_attr` is given invented
  `abi`/`pad` fields, and `LANDLOCK_RULE_TYPE_PATH_BENEATH` should be
  `LANDLOCK_RULE_PATH_BENEATH`. The post later contradicts its own struct.
- **`2026-06-18` FIDO2 in Rust** — `cbor = "0.5"` does not exist (max is 0.4.2,
  deprecated); `SigningKey<NistP256>` is invalid (already a concrete alias);
  three identifiers used without import.
- **`2026-06-09` io_uring in Rust** — `get_entry`, `buf_ring`, `res()` are none
  of them real on the pinned `io-uring` 0.7.0, and nothing is ever enqueued.
- **`2026-08-17` WebAuthn in Go** — an entire `webauthn/attestation` subpackage
  is fabricated, `RPOrigin` should be `RPOrigins []string`, and one line reads
  `func func(u *User)`.
- **`2026-06-26` WebAuthn/SimpleWebAuthn** — `generateChallenge` is not
  exported, two async calls are never awaited, `userID` must be a `Uint8Array`,
  and the verify calls use a field shape the library no longer exposes.
- **`2026-08-22` DNS resolver in Rust** — tokio's `UdpSocket` has no
  `try_clone()`, and `BinEncoder::new()` requires a buffer with no `as_bytes()`.
  Every response path fails to compile.
- **`2026-06-06` PostgreSQL eBPF** — `BufferGetAndPin` does not exist in
  PostgreSQL; the uprobe cannot resolve.
- **`2026-04-24` OPA/Terraform** — the Terraform provider `terraform-opa/opa`
  and data source `opa_policy_check` are both invented. `terraform init` fails.
- **`2026-05-23` Envoy/Wasm** — missing `impl Context for ...`, and
  `new_http_context` should be `create_http_context` returning `Option<...>`,
  so Envoy never obtains an HttpContext.
- **`2026-05-22` Rust ownership** — reproduces the Rust Book's canonical
  *non-compiling* lifetime example and claims it compiles. In a post about the
  borrow checker.

## Tier 3 — stale, misnamed, or cosmetic

Includes `class_create(THIS_MODULE, ...)` (the `owner` arg was dropped in kernel
6.4) in `2026-06-15` and `2026-08-13`; `wasm32-wasi` (removed from stable in
Rust 1.84) in `2026-06-20`; `gitRepo` volumes (removed in k8s 1.36) in
`2026-04-23`; `PodSecurityPolicy` (removed in 1.25) in `2026-04-22`; pre-v1 Rego
syntax in `2026-04-24`/`2026-04-26`; `CKV_AWS_18` vs `CKV_AWS_20` in `2026-04-25`;
`EF_VI` expanded wrongly in `2026-05-29`; unused imports breaking `go build` in
`2026-05-31` and `2026-06-02`; and a literal text-corruption splice
(`WantedBy=multi-u/sr/bin/systemctl enable legacy-app.servicelti-user.target`)
in `2026-09-05`.

Prose posts (4 findings): "MITRE ATT&CK for ML" should be **MITRE ATLAS**
(`2026-08-12`); CloudEvents is a **CNCF** project, not Cloud Security Alliance
(`2026-04-01`); "Microsoft's AMI (AI Model Inspector)" appears not to exist —
the real tool is Counterfit (`2026-04-12`); "OWASP's Machine Learning Security
Checklist" is really the **OWASP Machine Learning Security Top 10**
(`2026-04-10`).

The NIST AI RMF's four functions (Govern, Map, Measure, Manage) are described
correctly everywhere they appear, as are ISO/IEC 42001, NIST SP 800-57,
CRYSTALS-Kyber/Dilithium, SHAP/LIME, and the named IBM/Google tooling.

## Posts with no findings

38 of 42 prose posts, and roughly 45 of 148 code posts, came back clean —
including the network-namespaces post, the USB driver, the FUSE filesystem, the
x86-64 disassembler, the mmap post, the Go memory allocator, and the
Trivy supply-chain-incident post, whose specific factual claims were
cross-checked against multiple independent vendor writeups and hold up.

## Confidence

Findings were verified by the auditing agents against cited primary sources and
are recorded with those citations in the raw reports. They have **not** been
independently re-verified line by line by a second pass. Before acting on any
single item, re-check it — the same standard this audit applies to the posts.

Items the agents could not settle are recorded as SUSPECTED in the raw reports
and are deliberately excluded from the counts above.
