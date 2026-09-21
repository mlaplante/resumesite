---
title: "Crafting a Custom Linux Security Module for Mandatory Access Control"
date: 2026-05-27
category: "thought-leadership"
tags: []
excerpt: "The Linux kernel's Security Module (LSM) framework is a powerful, yet often underutilized, mechanism for extending the kernel's security capabilities...."
---

The Linux kernel's Security Module (LSM) framework is a powerful, yet often underutilized, mechanism for extending the kernel's security capabilities. While SELinux and AppArmor are the most well-known implementations, the LSM framework is designed to allow multiple security modules to coexist and provide fine-grained control over system resources. For organizations with unique security requirements, building a custom LSM can offer unparalleled flexibility and enforcement capabilities.

This post will delve into the practicalities of developing a basic custom LSM, focusing on how to hook into the kernel's internal operations to enforce mandatory access control (MAC) policies. We'll walk through the essential components, demonstrate how to attach your program to the kernel, and provide concrete examples of enforcing a simple policy.

## Understanding the LSM Framework

At its core, the LSM framework provides a set of "hooks" — specific points within the kernel's execution path where a registered security module can interject and make a policy decision. These hooks cover a vast array of operations, from file access and process creation to network interactions and inter-process communication.

When an operation occurs, the kernel calls the corresponding LSM hook. If a security module is registered for that hook, its function is executed. The module can then return `0` (permission granted), `-EPERM` (permission denied), or another negative error code to indicate a failure.

## Why You Can't Just `insmod` a Custom LSM

Before the 1990s-vintage kernel-module tutorials lead you astray: it is not possible to write a custom LSM as a standalone `.ko` file and load it at runtime with `insmod` on any kernel you're likely to be running today, and this isn't an oversight — it's deliberate.

Early in the LSM framework's life, a module *could* register itself dynamically against a single global `security_ops` pointer via `register_security()`. That capability was removed in Linux 2.6.24 (released January 2008) for a straightforward reason: if arbitrary code running after boot can register a security policy, the same privilege lets it register a *weaker* one, or unregister the real one outright — which defeats the entire premise of mandatory access control. See the kernel changelog discussion in ["Security: Introduce security= boot parameter"](https://lwn.net/Articles/272585/) and ["LSM: Add security= boot parameter"](https://lwn.net/Articles/271585/) on LWN for the original rationale.

From 2.6.24 onward, the "major" LSM model requires your hook implementations to be compiled directly into the kernel image and selected at boot via a kernel command-line parameter (historically `security=`, today more commonly the stackable `lsm=` parameter). There is no `.ko` you can hand to `insmod` — you'd need to patch and rebuild the kernel itself.

That's a real gap for teams who want a custom MAC policy without owning a kernel-rebuild pipeline, and it's exactly what **BPF LSM** (merged in kernel 5.7, 2020) was built to close. `CONFIG_BPF_LSM` lets you attach small, kernel-verified BPF programs directly to LSM hooks at runtime — no kernel patch, no reboot to load a new policy — while keeping the safety property that mattered in 2008: the BPF verifier, not your program's author, guarantees the code terminates, stays in bounds, and can't be used to smuggle in an unconstrained runtime module. The rest of this post builds a small BPF LSM program instead of a loadable kernel module.

## Setting Up Your Development Environment

BPF LSM programs are built with a different toolchain than a classic kernel module — you need a BPF-capable compiler and libbpf, not just the kernel headers package.

First, confirm your kernel was built with BPF LSM support:

```bash
grep BPF_LSM /boot/config-$(uname -r)
# CONFIG_BPF_LSM=y
```

If it's enabled but not active, add `bpf` to the `lsm=` kernel command-line parameter (edit `GRUB_CMDLINE_LINUX` in `/etc/default/grub`, run `update-grub` or `grub2-mkconfig`, then reboot). Once active, `bpf` will appear in the list of running LSMs:

```bash
cat /sys/kernel/security/lsm
# lockdown,capability,yama,apparmor,bpf
```

You'll also need a BPF compiler toolchain and libbpf. Package names vary by distribution, but on a recent Debian/Ubuntu system you're typically looking for `clang`, `llvm`, `libelf-dev`, `libbpf-dev`, and `bpftool` (the last is often packaged as part of `linux-tools-common`/`linux-tools-$(uname -r)`):

```bash
sudo apt update
sudo apt install clang llvm libelf-dev libbpf-dev linux-tools-common linux-tools-$(uname -r)
```

## Anatomy of a Custom BPF LSM

A custom BPF LSM consists of three parts:

1.  **The BPF program itself:** a small C file, compiled to BPF bytecode, containing one function per hook you want to implement. Each function is annotated with a `SEC("lsm/<hook_name>")` section name so libbpf and the verifier know which hook it targets.
2.  **A generated skeleton:** `bpftool gen skeleton` turns your compiled object into a typed C header, giving you a struct with a member for each program and each map, plus generated `open`/`load`/`destroy` functions.
3.  **A userspace loader:** a small program that loads the skeleton, attaches the program to its LSM hook with `bpf_program__attach_lsm()`, and keeps the process alive for as long as the policy should be enforced. Detaching (destroying the returned `bpf_link`) removes the hook.

Let's write a simple BPF LSM program that denies execution of any binary located in `/tmp` — the same policy as before, but implemented in a way that will actually attach on a modern kernel.

### Step 1: Write the BPF Program

We'll hook `bprm_check_security`, which the kernel calls before an executable is loaded into memory. Its real signature, straight from the kernel's hook table, is:

```c
// include/linux/lsm_hook_defs.h
LSM_HOOK(int, 0, bprm_check_security, struct linux_binprm *bprm)
```

BPF LSM programs for hooks that return an `int` are written with libbpf's `BPF_PROG` macro, which appends one extra trailing argument beyond the hook's own arguments: `ret`, the return value already produced by any BPF LSM program (or in-kernel LSM) earlier in the stack. If a previous program in the stack has already denied the operation, a well-behaved hook should pass that denial through rather than silently overriding it.

```c
// mylsm.bpf.c
#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>

char LICENSE[] SEC("license") = "GPL";

SEC("lsm/bprm_check_security")
int BPF_PROG(mylsm_bprm_check_security, struct linux_binprm *bprm, int ret)
{
	char path[16] = {};

	// Don't override a denial already produced earlier in the LSM stack.
	if (ret != 0)
		return ret;

	// bprm->filename is the pathname the caller asked to exec, before
	// resolution. BPF programs can't dereference kernel pointers
	// directly, so copy the leading bytes into a bounded on-stack
	// buffer with a safe read helper.
	if (bpf_probe_read_kernel_str(path, sizeof(path), bprm->filename) < 0)
		return 0;

	if (path[0] == '/' && path[1] == 't' && path[2] == 'm' &&
	    path[3] == 'p' && path[4] == '/') {
		bpf_printk("mylsm: denying exec of %s\n", path);
		return -EPERM;
	}

	return 0;
}
```

Note what's *not* here compared to the old approach: there's no `struct security_operations`, no registration call, and no security-blob allocation. State that needs to persist across invocations — counters, allow-lists, anything more than a single decision — belongs in a BPF map, updated from userspace, rather than in a manually-managed kernel object.

### Step 2: Build It

BPF LSM programs are compiled against the running kernel's own type information (BTF), which gives you CO-RE (Compile Once – Run Everywhere) portability without needing the full kernel header tree:

```bash
# Generate a header with every type the running kernel exposes via BTF
bpftool btf dump file /sys/kernel/btf/vmlinux format c > vmlinux.h

# Compile the BPF program to an ELF object containing BPF bytecode
clang -O2 -g -target bpf -c mylsm.bpf.c -o mylsm.bpf.o

# Generate the typed skeleton header from the compiled object
bpftool gen skeleton mylsm.bpf.o > mylsm.skel.h
```

### Step 3: Load, Attach, and Test

A minimal loader opens the skeleton, loads the program into the kernel (where the verifier checks it), attaches it to the `bprm_check_security` hook, and waits:

```c
// loader.c
#include <bpf/libbpf.h>
#include <signal.h>
#include <stdio.h>
#include <unistd.h>
#include "mylsm.skel.h"

static volatile sig_atomic_t exiting;
static void handle_sigint(int sig) { exiting = 1; }

int main(void)
{
	struct mylsm_bpf *skel;
	struct bpf_link *link;

	skel = mylsm_bpf__open();
	if (!skel) {
		fprintf(stderr, "failed to open BPF skeleton\n");
		return 1;
	}

	if (mylsm_bpf__load(skel)) {
		fprintf(stderr, "failed to load BPF skeleton (is CONFIG_BPF_LSM on, and is 'bpf' in the lsm= boot param?)\n");
		mylsm_bpf__destroy(skel);
		return 1;
	}

	link = bpf_program__attach_lsm(skel->progs.mylsm_bprm_check_security);
	if (!link) {
		fprintf(stderr, "failed to attach LSM program\n");
		mylsm_bpf__destroy(skel);
		return 1;
	}

	signal(SIGINT, handle_sigint);
	printf("mylsm attached. Ctrl-C to detach and exit.\n");
	while (!exiting)
		pause();

	bpf_link__destroy(link);
	mylsm_bpf__destroy(skel);
	return 0;
}
```

Build and run it as root (attaching an LSM program requires `CAP_SYS_ADMIN` / `CAP_BPF` privileges):

```bash
clang -O2 -g -c loader.c -o loader.o
clang loader.o -lbpf -lelf -lz -o loader
sudo ./loader
```

While it's running, verify the program is actually attached:

```bash
sudo bpftool prog list | grep -A2 lsm
```

Then, from another terminal, create and try to run a script from `/tmp`:

```bash
echo '#!/bin/bash' > /tmp/test_script.sh
echo 'echo "Hello from /tmp!"' >> /tmp/test_script.sh
chmod +x /tmp/test_script.sh
/tmp/test_script.sh
```

You should see:

```
bash: /tmp/test_script.sh: Operation not permitted
```

And in the trace pipe (`sudo cat /sys/kernel/tracing/trace_pipe`, since `bpf_printk` writes there):

```
mylsm: denying exec of /tmp/test_scr
```

Press Ctrl-C in the loader's terminal to detach; `/tmp/test_script.sh` will execute normally again once the program is unloaded.

## Advanced Considerations and Takeaways

*   **State instead of security blobs:** The classic LSM model lets you attach a "security blob" to a task, file, or inode via hooks like `security_task_alloc()`. A BPF LSM program doesn't get one of those — instead, anything it needs to remember between invocations (an allow-list, a counter, a decision cache) lives in a BPF map that you create alongside the program and update from userspace or from other attached programs.
*   **Coexistence:** BPF LSM hooks run alongside any compiled-in LSMs (SELinux, AppArmor, etc.) and any other BPF LSM programs attached to the same hook, as part of the kernel's LSM call chain. The order in which stacked LSMs run is controlled by the `lsm=` boot parameter's ordering, not by anything your program requests at attach time — which is exactly the kind of decision the pre-2008 dynamic-registration model let a module make for itself, and exactly what got removed.
*   **Policy distribution:** For a production policy, you need a way to change behavior without recompiling and re-attaching the program. BPF maps are the natural mechanism here — update a map's contents from a userspace control process (via `libbpf`, or by reading/writing a pinned map with `bpftool map update`) and have the BPF program consult it on each invocation.
*   **Performance:** LSM hooks are called frequently, and the verifier enforces bounded, loop-safe execution for exactly this reason. Keep your hook logic simple — a handful of comparisons and map lookups, not extensive computation.
*   **Error Handling:** Always check the return value of `bpf_probe_read_kernel_str()` and similar helpers; a failed read should fail safe (permit, and log, rather than crash the verifier's assumptions) unless your policy explicitly wants to fail closed.
*   **Testing:** Thorough testing is paramount. Develop a comprehensive test suite that covers all policy rules and edge cases, including what happens when a read helper fails.

Building a custom LSM is a deep dive into kernel internals, but it no longer requires a kernel rebuild to iterate on. BPF LSM gives you the same hook points classic LSMs use, with the verifier standing in for the trust a loadable module would otherwise require. This example provides a foundation; the real power comes from adapting these concepts — and the maps, not blobs, mental model — to your unique security challenges.
