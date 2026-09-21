import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { findTruncation } from '../../scripts/lib/blog-post.js';

// Mirrors the build-time content-collection schema (blog-src/src/content.config.ts)
// so authoring mistakes surface in a fast `npm test` run instead of only at the
// full `astro build`. The glob loader skips files whose names start with `_` or
// an uppercase letter (drafts / CLAUDE.md), so apply the same filter here.
const POSTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../blog-src/src/content/posts',
);

function postFiles(): string[] {
  return readdirSync(POSTS_DIR).filter(
    (f) => f.endsWith('.md') && /^[^_A-Z]/.test(f),
  );
}

// Extract a single scalar frontmatter value (handles optional surrounding
// quotes). Returns null when the key is absent or commented out.
function frontmatter(raw: string): Record<string, string> {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fields: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    if (/^\s*#/.test(line)) continue; // skip commented-out hints
    const kv = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fields[kv[1]] = value;
  }
  return fields;
}

const files = postFiles();

describe('blog content frontmatter', () => {
  it('has at least one published post', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s has valid frontmatter', (file) => {
    const raw = readFileSync(join(POSTS_DIR, file), 'utf8');
    const fm = frontmatter(raw);

    // Required fields (schema: title, date, category, excerpt).
    for (const key of ['title', 'date', 'category', 'excerpt'] as const) {
      expect(fm[key], `${file}: missing "${key}"`).toBeTruthy();
    }

    // Lengths match the Zod schema bounds.
    expect(fm.title.length, `${file}: title too long`).toBeLessThanOrEqual(200);
    expect(fm.excerpt.length, `${file}: excerpt too long`).toBeLessThanOrEqual(
      300,
    );

    // Category is a lowercase-hyphenated slug.
    expect(fm.category, `${file}: category not slug-cased`).toMatch(
      /^[a-z0-9-]+$/,
    );

    // Date parses to a real calendar date.
    expect(
      Number.isNaN(new Date(fm.date).getTime()),
      `${file}: unparseable date "${fm.date}"`,
    ).toBe(false);

    // updated, when present, is not before date.
    if (fm.updated) {
      expect(
        new Date(fm.updated).getTime(),
        `${file}: updated precedes date`,
      ).toBeGreaterThanOrEqual(new Date(fm.date).getTime());
    }
  });

  it('has unique slugs (filenames)', () => {
    const slugs = files.map((f) => f.replace(/\.md$/, ''));
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  // The AI pipeline once published the same post twice under different date
  // prefixes (2026-05-03-x.md / 2026-05-13-x.md) — treat any repeat of the
  // date-less slug or the title as a duplicate.
  it('has unique slugs ignoring the date prefix', () => {
    const bare = files.map((f) => f.replace(/^\d{4}-\d{2}-\d{2}-/, ''));
    const dupes = bare.filter((s, i) => bare.indexOf(s) !== i);
    expect(dupes, `duplicate posts: ${dupes.join(', ')}`).toEqual([]);
  });

  // blog/[slug].astro renders <h1>{title}</h1>; a body that opens with its own
  // H1 ships two identical H1s. The draft generator strips it
  // (scripts/lib/blog-post.js stripLeadingHeading) — this guards hand edits.
  it('no post body opens with a level-1 heading', () => {
    const offenders = postFiles().filter((f) => {
      const raw = readFileSync(join(POSTS_DIR, f), 'utf8');
      const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/^\s+/, '');
      return /^#\s/.test(body) || /^[^\n]+\n=+\s*$/m.test(body.split('\n').slice(0, 2).join('\n'));
    });
    expect(offenders).toEqual([]);
  });

  it('has unique titles', () => {
    const titles = files.map(
      (f) => frontmatter(readFileSync(join(POSTS_DIR, f), 'utf8')).title?.toLowerCase() ?? '',
    );
    const dupes = titles.filter((t, i) => titles.indexOf(t) !== i);
    expect(dupes, `duplicate titles: ${dupes.join(', ')}`).toEqual([]);
  });

  // Posts published after this date must ship with tags — the draft pipeline
  // now generates them, and empty tags mean the review checklist was skipped.
  // Older posts are grandfathered in rather than backfilled.
  const TAGS_REQUIRED_AFTER = '2026-07-04';

  it.each(files)('%s has tags when recent enough to require them', (file) => {
    const raw = readFileSync(join(POSTS_DIR, file), 'utf8');
    const fm = frontmatter(raw);
    if (fm.date <= TAGS_REQUIRED_AFTER) return;
    expect(fm.tags, `${file}: posts dated after ${TAGS_REQUIRED_AFTER} must have at least one tag`).toMatch(
      /\[\s*".+"\s*\]|\[\s*'.+'\s*\]/,
    );
  });
});

// Posts written before the generator checked Gemini's `finishReason` (see
// scripts/generate-post-gemini.js). The 2500-token output cap silently cut
// long technical posts mid-sentence and the pipeline published them anyway.
// They are being repaired in batches; this list only shrinks — a new entry
// means the guard regressed.
const KNOWN_TRUNCATED = new Set([
  '2026-04-24-automating-compliance-checks-with-opa-and-terraform-for-kubernetes-deployments.md',
  '2026-04-26-automating-secure-aws-multi-account-deployment-with-terraform-and-opa.md',
  '2026-04-28-from-zero-to-secure-building-a-hardened-kubernetes-cluster-with-gitops-and-ebpf-for-runtime-security.md',
  '2026-05-01-automating-cloud-incident-response-with-serverless-functions-and-event-driven-architectures.md',
  '2026-05-02-secure-multi-tenant-container-isolation-with-ebpf-and-seccomp.md',
  '2026-05-03-building-immutable-infrastructure-with-nix-and-aws-cdk.md',
  '2026-05-07-demystifying-ebpf-for-real-time-network-performance-monitoring-and-troubleshooting.md',
  '2026-05-09-automating-incident-response-playbooks-with-serverless-functions-and-infrastructure-as-code.md',
  '2026-05-11-automating-cloud-incident-response-with-serverless-functions-and-infrastructure-as-code.md',
  '2026-05-16-automating-kubernetes-policy-enforcement-with-opa-gatekeeper-and-gitops.md',
  '2026-05-19-custom-tcp-congestion-control-for-low-latency-linux-networks.md',
  '2026-05-20-unlocking-postgresql-performance-a-deep-dive-with-ebpf-and-explain-analyze.md',
  '2026-05-23-building-a-secure-and-observable-data-plane-with-envoy-and-webassembly-filters.md',
  '2026-05-24-demystifying-ptrace-building-a-custom-debugger-for-linux-binaries.md',
  '2026-05-25-auditing-system-calls-with-a-custom-linux-kernel-module.md',
  '2026-05-26-mastering-ebpf-for-custom-network-policy-enforcement-in-kubernetes.md',
  '2026-05-29-achieving-nanosecond-latency-a-deep-dive-into-kernel-bypass-networking.md',
  '2026-05-31-mastering-go-microservice-latency-p99-optimization-with-go-tool-trace.md',
  '2026-06-02-golang-microservices-memory-profiling-with-pprof-and-go-tool-pprof.md',
  '2026-06-03-boosting-network-performance-with-io-uring-and-ebpf-in-linux.md',
  '2026-06-04-unearthing-go-microservice-latency-a-deep-dive-with-pprof-and-custom-tracing.md',
  '2026-06-05-debugging-kernel-panics-a-hands-on-guide-to-kdump-and-crash.md',
  '2026-06-09-unlocking-peak-performance-with-rust-and-io-uring.md',
  '2026-06-10-from-strace-to-ebpf-advanced-linux-system-call-tracing-for-security-forensics.md',
  '2026-06-11-pxe-ansible-and-bgp-crafting-a-bare-metal-kubernetes-cluster.md',
  '2026-06-18-building-a-custom-fido2-authenticator-with-rust-and-webauthn.md',
  '2026-06-19-demystifying-sched-yield-when-and-how-to-use-it-for-optimal-concurrency-in-linux-applications.md',
  '2026-06-20-webassembly-for-serverless-secure-performant-functions-beyond-the-browser.md',
  '2026-06-21-crafting-a-secure-key-value-store-in-rust-for-embedded-systems.md',
  '2026-06-24-real-time-file-integrity-with-fanotify-and-lsms.md',
  '2026-06-25-unraveling-race-conditions-debugging-concurrency-bugs-with-tsan.md',
  '2026-06-26-webauthn-with-yubikeys-fido2-attestation-and-assertion-deep-dive.md',
  '2026-06-28-secure-ephemeral-memory-with-memfd-create-and-seccomp.md',
  '2026-08-13-crafting-a-linux-kernel-module-for-hardware-root-of-trust-attestation.md',
  '2026-08-14-demystifying-io-uring-building-high-performance-secure-network-services-in-rust.md',
  '2026-08-15-deep-dive-crafting-custom-system-call-interceptors-with-ebpf-for-runtime-security.md',
  '2026-08-16-mastering-mmap-secure-memory-management-for-high-performance-applications.md',
  '2026-08-17-crafting-a-webauthn-server-in-go-deep-dive-into-advanced-attestation.md',
  '2026-08-18-unveiling-the-linux-kernel-s-dark-corners-debugging-with-kprobes-and-ftrace.md',
  '2026-08-20-crafting-a-custom-memory-allocator-for-performance-critical-go-applications.md',
  '2026-08-22-building-a-custom-dns-resolver-in-rust-for-enhanced-security-and-performance.md',
  '2026-08-23-diving-deep-crafting-a-custom-kernel-fuzzer-with-syzkaller.md',
  '2026-08-24-building-a-secure-high-performance-key-value-store-with-lsm-trees-in-rust.md',
  '2026-08-25-building-a-custom-linux-kernel-fuzzer-with-syzkaller-from-setup-to-finding-bugs.md',
  '2026-08-26-crafting-a-custom-linux-kernel-module-for-encrypted-inter-process-communication.md',
  '2026-08-27-demystifying-mount-setattr-crafting-immutable-container-filesystems-for-enhanced-security.md',
  '2026-08-28-demystifying-chroot-and-pivot-root-building-secure-sandboxes-for-legacy-applications.md',
  '2026-08-30-unmasking-kubernetes-network-partitions-with-netstat-ss-and-tcpdump.md',
  '2026-09-01-demystifying-execveat-building-custom-process-sandboxes-for-enhanced-container-security.md',
  '2026-09-02-crafting-a-custom-tls-interception-proxy-with-ebpf-for-deep-packet-inspection.md',
  '2026-09-05-containerizing-legacy-with-podman-a-systemd-deep-dive-for-production.md',
  '2026-09-05-demystifying-memfd-secret-building-secure-confidential-computing-enclaves-in-linux.md',
  '2026-09-06-demystifying-msg-control-crafting-custom-linux-socket-options-for-advanced-network-security.md',
  '2026-09-09-deep-dive-crafting-custom-seccomp-and-apparmor-profiles-for-kubernetes-hardening.md',
  '2026-09-10-dissecting-the-linux-clone3-syscall-crafting-next-gen-container-runtimes.md',
  '2026-09-11-demystifying-landlock-crafting-fine-grained-filesystem-sandboxes-for-linux-applications.md',
  '2026-09-12-crafting-a-custom-fuzzer-for-webassembly-modules-with-libfuzzer.md',
  '2026-09-13-crafting-a-custom-linux-capabilities-manager-with-libcap-and-ebpf-for-fine-grained-process-security.md',
  '2026-09-15-crafting-a-custom-x86-64-disassembler-in-rust-for-binary-analysis-and-security-audits.md',
  '2026-09-16-crafting-a-custom-linux-filesystem-with-fuse-for-encrypted-storage.md',
  '2026-09-17-demystifying-pkey-alloc-building-confidential-computing-enclaves-with-memory-protection-keys.md',
  '2026-09-18-mastering-bpf-type-format-btf-for-advanced-ebpf-program-debugging.md',
  '2026-09-19-dissecting-bpf-callbacks-crafting-custom-network-filters-and-security-hooks.md',
  '2026-09-20-crafting-a-custom-usb-device-driver-in-linux-for-secure-communication.md',
]);

describe('blog content completeness', () => {
  it.each(files)('%s is not truncated', (file) => {
    const raw = readFileSync(join(POSTS_DIR, file), 'utf8');
    const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '');
    const reason = findTruncation(body);
    if (KNOWN_TRUNCATED.has(file)) return; // grandfathered, pending repair
    expect(reason, `${file}: ${reason}`).toBeNull();
  });

  // Burn-down tripwire: once a post is repaired, drop it from KNOWN_TRUNCATED
  // so it can never silently regress back to being truncated.
  it('has no stale entries in KNOWN_TRUNCATED', () => {
    const repaired = [...KNOWN_TRUNCATED].filter((file) => {
      if (!files.includes(file)) return false;
      const raw = readFileSync(join(POSTS_DIR, file), 'utf8');
      return findTruncation(raw.replace(/^---\n[\s\S]*?\n---\n/, '')) === null;
    });
    expect(
      repaired,
      `these posts are fixed — remove them from KNOWN_TRUNCATED: ${repaired.join(', ')}`,
    ).toEqual([]);
  });
});
