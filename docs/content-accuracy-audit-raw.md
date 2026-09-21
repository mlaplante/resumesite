# Corpus accuracy audit — raw findings

Severity key: **CENTRAL** = the post's main claim/demo is wrong. **MODERATE** = a
supporting detail is wrong. **COSMETIC** = illustrative text only.

## Batch 1

- **CENTRAL** `2026-04-18-implementing-zero-trust-network-segmentation-with-ebpf-a-hands-on-guide.md`
  — uses libc `htons()`/`htonl()` inside a BPF program. BPF compiles freestanding with no
  libc; must be `bpf_htons()`/`bpf_htonl()` from `bpf/bpf_endian.h`. The post's only code
  sample will not load.
- **CENTRAL** same file — `bpftool map update pinned /sys/fs/bpf/allowed_ips key 0xC0A80101`
  is invalid syntax (keys are space-separated bytes: `key 0xc0 0xa8 0x01 0x01`), and that
  map is never pinned anywhere in the walkthrough.
- **CENTRAL** `2026-04-15-zero-trust-in-practice-implementing-just-in-time-privileged-access-with-hashicorp-vault-and-terraform.md`
  — `default_sts_ttl`/`max_sts_ttl` only apply to `assumed_role`/`federation_token`, not the
  `credential_type = "iam_user"` the post uses. Following it yields ~32-day admin AWS keys,
  not the promised 1 hour. Directly inverts the post's security thesis.

## Batch 2

- **CENTRAL** `2026-04-22-implementing-zero-trust-network-segmentation-with-ebpf-hands-on-code-and-architecture-patterns.md`
  — both demos use `SEC("kprobe/tcp_connect")` and `return 1` to "block". Plain kprobes
  cannot alter execution; blocking needs `bpf_override_return()`. Nothing is blocked.
- **CENTRAL** `2026-04-27-automating-zero-trust-network-microsegmentation-with-ebpf-and-kubernetes.md`
  — CiliumNetworkPolicy lists `toFQDNs` and `toPorts` as separate egress items, so they OR:
  actually allows all ports to `*.example.com` AND 443 to anywhere. More permissive than stated.
- **CENTRAL** `2026-05-04-building-resilient-systems-immutable-infrastructure-with-nixos-and-hashicorp-nomad.md`
  — `services.nomad.client.enable` is not a real NixOS option; real toggle is
  `settings.client.enabled`. Eval error, and client mode never activates.
- **CENTRAL** `2026-04-24-automating-compliance-checks-with-opa-and-terraform-for-kubernetes-deployments.md`
  — invented Terraform provider `terraform-opa/opa`, invented `data "opa_policy_check"`, and a
  `.json` attribute on `kubernetes_deployment` that does not exist. `terraform init` fails.
- **CENTRAL** `2026-04-26-automating-secure-aws-multi-account-deployment-with-terraform-and-opa.md`
  — inline `acl`/`versioning`/`server_side_encryption_configuration` on `aws_s3_bucket` are
  unconfigurable since AWS provider v5. The security baseline doesn't apply as written.
- **CENTRAL** `2026-04-23-automating-zero-downtime-database-schema-migrations-with-gitops-and-kubernetes.md`
  — flagship manifest uses `gitRepo` volumes, removed in Kubernetes v1.36 (shipped the day
  before the post).
- **CENTRAL** `2026-05-03-building-immutable-infrastructure-with-nix-and-aws-cdk.md`
  — `virtualisation.amazon-image.ami.name`/`.description` don't exist in the imported module;
  real option is `amazonImage.name` in a different, unimported file. Core artifact won't eval.
- **CENTRAL** `2026-04-28-from-zero-to-secure-...-gitops-and-ebpf-for-runtime-security.md`
  — `source.toolkit.fluxcd.io/v2beta1` never existed for HelmRepository (v2* is the
  `helm.toolkit.fluxcd.io` line). `kubectl apply` fails.
- **CENTRAL** same file — Falco rule uses `evt.is_privileged`, not a supported field; real one
  is `container.privileged`. Rule won't compile.
- **CENTRAL** `2026-04-24` + `2026-04-26` — all Rego uses pre-v1 `deny[msg] { }` with no
  `import rego.v1`. Under OPA v1.0+ the shown `conftest test` command is a parse error.
- **MODERATE** `2026-04-28` — Falco Helm `driver.kind: eBPF`; valid values are `kmod`,
  `modern_ebpf`, `auto`.
- **MODERATE** `2026-04-28` — comment claims a namespaced NetworkPolicy can apply cluster-wide.
- **MODERATE** `2026-04-22` — recommends `PodSecurityPolicy`, removed in k8s 1.25.
- **MODERATE** `2026-04-25-automating-threat-modeling-with-infrastructure-as-code-and-static-analysis.md`
  — Checkov public-ACL finding labelled `CKV_AWS_18`; that ID is S3 access logging, the real
  one is `CKV_AWS_20`.

## Batch 7

- **CENTRAL** `2026-08-03-governing-federated-learning-for-enhanced-multi-cloud-security.md`
  — `DifferentiallyPrivateFactory(SumFactory(), noise_multiplier=, clip_norm=)` is the wrong
  constructor (first arg must be a `tfp.DPQuery`; those kwargs exist only on `gaussian_fixed`).
  TypeError as written.
- **CENTRAL** same file — `tff.learning.algorithms.build_weighted_averaging_process` does not
  exist; real name is `build_weighted_fed_avg`.
- **COSMETIC** `2026-08-04-quantum-threat-to-pki-...md` — `--script-args "ssl-cert.check-date"`;
  the `ssl-cert` NSE script takes no arguments at all.
- **COSMETIC** same file — `grep "Public-Key Algorithm"` never matches; openssl prints
  `Public Key Algorithm:` and `Public-Key:` as separate lines.
- **COSMETIC** `2026-07-24-governing-ai-powered-supply-chain-security-...md` — `dvc add`
  creates a `.gitignore`, not the `data/.dvcignore` the post then tries to `git add`.

## Batch 6

- **CENTRAL** `2026-06-26-webauthn-with-yubikeys-fido2-attestation-and-assertion-deep-dive.md`
  — four separate breakages: `generateChallenge` is not exported by `@simplewebauthn/server`;
  `generateRegistrationOptions`/`generateAuthenticationOptions` are async and are never awaited
  (so `res.json(options)` serialises a pending Promise); `userID` must be a `Uint8Array` and the
  post passes a string (throws at runtime); and the verify calls use the old
  `authenticator: {credentialID, credentialPublicKey, counter}` shape instead of the current
  `credential: {id, publicKey, counter}`. The signature-counter clone detection the post calls
  out as its key takeaway is exactly the code that would not run.
- **CENTRAL** `2026-06-24-real-time-file-integrity-with-fanotify-and-lsms.md`
  — `FAN_CREATE`/`FAN_DELETE`/`FAN_ATTRIB`/`FAN_MOVE` require `FAN_REPORT_FID`, which is mutually
  exclusive with the `FAN_CLASS_CONTENT` the post inits with. `fanotify_mark()` returns EINVAL and
  the flagship example exits before monitoring anything.
- **CENTRAL** `2026-07-09-ai-governance-for-secure-container-orchestration-a-kube-native-approach.md`
  — `admission.k88s.gatekeeper.sh` (double 8) is a typo'd target, and the Rego queries
  `data.kubernetes...` when Gatekeeper exposes cached resources at `data.inventory...`.
- **CENTRAL (security-inverted)** `2026-07-06-governing-ai-powered-red-teaming-ethical-boundaries-and-strategic-advantages.md`
  — IAM `Deny` + `StringNotEquals ec2:VpcTag/Environment = Production` denies everything EXCEPT
  Production, the exact inverse of the stated intent of confining a red-team agent to a sandbox.
- **MODERATE** `2026-06-27-optimizing-ebpf-program-performance-deep-dive-into-verifier-and-jit.md`
  — claims helper calls "incur a context switch cost". Helper calls are direct in-kernel calls,
  JITed inline; no transition occurs. Wrong in a post about performance internals.

## Batch 4

- **CENTRAL** `2026-05-27-crafting-a-custom-linux-security-module-for-mandatory-access-control.md`
  — built on `struct security_operations` + `lsm_register_security()`, an API removed from the
  kernel in 2.6.24 (2008) precisely to stop runtime-loadable LSMs. Every step (compile → insmod →
  test → rmmod) is impossible on any supported kernel. Worst finding in the corpus.
- **CENTRAL** `2026-05-26-mastering-ebpf-for-custom-network-policy-enforcement-in-kubernetes.md`
  — `bpf_memcmp()` is not a real BPF helper; it is the function the whole HTTP match depends on.
- **CENTRAL** same file — `skb->len_diff` is not a `__sk_buff` field (it is a parameter name on
  `bpf_skb_adjust_room()`, borrowed from the wrong place).
- **CENTRAL** same file — the `cursor_advance` macro double-scales pointer arithmetic (`ptr += n`
  already scales by `sizeof(*ptr)`), so header offsets jump 196 bytes instead of 14 and the
  program falls through to pass traffic instead of enforcing policy.
- **CENTRAL** `2026-06-06-unlocking-postgresql-performance-with-custom-ebpf-probes.md`
  — `BufferGetAndPin` does not exist in PostgreSQL; the uprobe cannot resolve. Real entry points
  are `ReadBuffer()`/`ReadBufferExtended()`.
- **CENTRAL** `2026-05-31-mastering-go-microservice-latency-p99-optimization-with-go-tool-trace.md`
  — the "build and load-test this" snippet imports `sync` unused; `go build` fails.
- **CENTRAL** `2026-06-02-golang-microservices-memory-profiling-with-pprof-and-go-tool-pprof.md`
  — same: imports `time` unused; does not compile.
- **MODERATE** `2026-06-05-debugging-kernel-panics-a-hands-on-guide-to-kdump-and-crash.md`
  — `dump_filter 0x1f` is not a kdump.conf directive; it is silently ignored. Real mechanism is
  `-d <bitmask>` on the `core_collector makedumpfile` line.
- **MODERATE** `2026-05-30-leveraging-hardware-assisted-virtualization-for-robust-container-security.md`
  — says gVisor's ptrace platform leverages EPT/RVI. Inverted: ptrace explicitly does not use
  hardware virtualisation; that is the separate KVM platform.
- **MODERATE** `2026-05-29-achieving-nanosecond-latency-a-deep-dive-into-kernel-bypass-networking.md`
  — EF_VI expanded as "Enhanced Function Virtualization Interface"; it is "EtherFabric Virtual Interface".
- **COSMETIC** `2026-05-25-auditing-system-calls-with-a-custom-linux-kernel-module.md`
  — `#include <linux/dentry.h>` does not exist (it is `<linux/dcache.h>`); the include is unused.
- **COSMETIC** `2026-05-26` — `HTTP_HEALTHZ_LEN` is 7 but `"/healthz"` is 8 characters.

## Batch 9

- **CENTRAL** `2026-08-27-demystifying-mount-setattr-...md` — `MOUNT_ATTR_IMMUTABLE` does not
  exist (already known), AND the post gives `mount_setattr` only 4 parameters; the real syscall
  takes 5 (the trailing `size_t size`). Both the premise and the prototype are wrong.
- **CENTRAL** `2026-09-05-demystifying-memfd-secret-...md` — `memfd_secret(MFD_CLOEXEC)` is
  undefined (the syscall accepts only `O_CLOEXEC`; `SECRETMEM_FLAGS_MASK` is literally 0x0);
  `MFD_SECRET_EXEC` is invented and claims a capability the syscall does not have; and
  `__NR_memfd_secret 461` is wrong (447 on x86_64).
- **CENTRAL** `2026-09-01-demystifying-execveat-...md` — the seccomp rule uses `SCMP_A1` for
  `dirfd` and `SCMP_A2` for `pathname`, but those are args 0 and 1. As written the filter
  matches on the `argv`/`envp` pointers and does not filter by path at all.
- **CENTRAL** `2026-09-07-ssh-hardening-with-fido2-...md` — `ssh-keygen -t sk-ecdsa` /
  `-t sk-ed25519` are backwards; real types are `ecdsa-sk` / `ed25519-sk`. The post's core
  commands fail verbatim. Also invents `AgentForwardingAllowGroups`/`DenyGroups` directives.
- **CENTRAL** `2026-09-05-containerizing-legacy-with-podman-...md` — `TimeoutStopUSec=70s` is a
  runtime property name, not a unit directive (`TimeoutStopSec=70`), and one unit file contains
  spliced garbage: `WantedBy=multi-u/sr/bin/systemctl enable legacy-app.servicelti-user.target`.
- **COSMETIC** `2026-08-28-deep-dive-reverse-engineering-firmware-with-ghidra-...md` —
  `MIPS:32:default:BE:V850E1_MIPS` is garbled; real IDs look like `MIPS:BE:32:default`, and
  V850E1 is an unrelated Renesas architecture.
- **COSMETIC** `2026-08-29-blazing-fast-containers-...crun-and-systemd-nspawn.md` — `--cpu-set`
  and `--memory` are not nspawn flags (`--cpu-affinity=`, or `--property=MemoryMax=`).
- **COSMETIC** `2026-08-25-building-a-custom-linux-kernel-fuzzer-with-syzkaller-...md` —
  `CONFIG_DEBUG_SYSCALL=y` is not a real Kconfig symbol.
- **COSMETIC** `2026-09-02-crafting-a-custom-tls-interception-proxy-with-ebpf-...md` — Go loader
  calls `link.Kprobe` without importing `github.com/cilium/ebpf/link`.

## Batches 3,5,8,10 + prose — pending
