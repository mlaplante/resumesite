---
title: "Linux Kernel TCP RCE: Find Exposed Hosts, Patch RHEL, and Mitigate Ubuntu"
date: 2026-11-03
category: "thought-leadership"
tags: ["linux", "vulnerability-management", "patch-management", "rhel", "ubuntu", "network-security"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "A remotely reachable, unauthenticated bug in the kernel's TCP code is one of the worst kinds of vulnerability. It doesn't matter how well you hardened..."
---

A remotely reachable, unauthenticated bug in the kernel's TCP code is one of the worst kinds of vulnerability. It doesn't matter how well you hardened your nginx config or how tightly you scoped your IAM roles. If the packet reaches the kernel, the kernel is the attack surface.

That's the situation with **CVE-2026-98432**, a use-after-free in the Linux kernel's IPv4 TCP implementation, rated **9.8**. Red Hat has shipped fixed kernels for **RHEL 8, 9, and 10**. Ubuntu has fixes for its **three newest LTS releases**, but as of this writing they're in the **opt-in testing channel**, with no announced date for a regular update.

Many of us run both distros, so we have two problems at once. The RHEL fleet needs a fast, verified patch-and-reboot cycle. The Ubuntu fleet needs mitigation while we wait, plus a clear decision about whether to pull kernels from testing for the most exposed hosts.

This post covers how I'd run this, step by step, with commands and configs you can adapt.

## What We Know and What We Don't

Separate facts from assumptions before you start.

**Known (from public reporting):**
- It's a use-after-free in the IPv4 TCP code.
- A remote, unauthenticated attacker can reach it.
- It carries a 9.8 severity rating.
- RHEL 8, 9, and 10 have fixed kernels available.
- Ubuntu's fixes for its three newest LTS releases are in the opt-in testing channel, with no date for general release.

**Not confirmed. Check the vendor advisories before relying on any of these:**
- The exact triggering conditions. It's unclear whether the attacker needs an open listening port, an established connection, or just any TCP packet reaching the host.
- Whether IPv6 code paths are affected. The bug is described as being in IPv4 TCP code. Don't assume IPv6 is safe until the advisory says so.
- Which specific kernel package versions contain the fix for each RHEL minor release and Ubuntu kernel flavor.
- Whether live patches (kpatch for RHEL, Canonical Livepatch for Ubuntu) are available for this CVE.
- Whether exploitation has been seen in the wild.

My working assumption until the advisories say otherwise: **any host that accepts inbound TCP from an untrusted network is exposed.** That rule is conservative and it determines what gets patched first.

## The Triage Plan

Here's the order of operations:

1. **Find exposed hosts.** Build a list of Linux hosts reachable over TCP from untrusted networks, and record their distro and running kernel.
2. **Patch RHEL now.** Fixed kernels exist. Roll them out, reboot, and verify the *running* kernel.
3. **Mitigate Ubuntu.** Reduce network exposure, check for live patch coverage, and selectively use testing-channel kernels where the risk justifies it.
4. **Track to closure.** Re-check daily until Ubuntu's fix lands in the regular update channel.

## Step 1: Find Exposed Hosts

"Exposed" has three parts, and you need all three:

- **Inside view:** what the host is listening on.
- **Outside view:** what is actually reachable from untrusted networks.
- **Control plane view:** what your cloud firewall rules allow.

### Inside View: Listening TCP Sockets and Kernel Version

Start with a fleet-wide inventory. This Ansible playbook collects distro, running kernel, and non-loopback TCP listeners into one CSV-friendly line per host:

```yaml
# inventory_tcp_exposure.yml
- name: Inventory kernel and TCP listeners
  hosts: linux
  gather_facts: true
  become: true
  tasks:
    - name: Collect non-loopback TCP listeners
      ansible.builtin.shell: |
        ss -H -ltn | awk '{print $4}' \
          | grep -vE '^(127\.|\[::1\]|::1)' \
          | sort -u | paste -sd ';' -
      register: listeners
      changed_when: false

    - name: Emit summary line
      ansible.builtin.debug:
        msg: >-
          {{ inventory_hostname }},{{ ansible_distribution }},
          {{ ansible_distribution_version }},{{ ansible_kernel }},
          {{ listeners.stdout | default('none') }}
```

Run it and pull the summary lines out:

```bash
ansible-playbook -i inventory/ inventory_tcp_exposure.yml \
  | grep -oP '"msg": "\K[^"]+' > tcp_exposure_$(date +%F).csv
```

A host with zero non-loopback listeners is lower risk, but not zero risk. We don't yet know if the bug can be triggered without a listening socket, so these hosts get deprioritized, not excluded.

### Outside View: Scan From Where the Attacker Sits

Internal inventory shows intent. An external scan shows reality. NAT rules, load balancers, and forgotten port-forwards don't appear in `ss` output.

Run a scan from an untrusted vantage point, such as a cloud VM outside your environment, against your public address space:

```bash
# Scan your public ranges (only ones you own and are authorized to test)
nmap -sS -Pn -n --open -p- --min-rate 2000 \
  -iL public_ranges.txt -oG - \
  | awk '/Ports:/{print $2}' | sort -u > externally_reachable.txt

wc -l externally_reachable.txt
```

Then map those IPs back to hosts in your CMDB or the inventory CSV. Prioritize any host that shows up here *and* runs an unpatched kernel.

### Control Plane View: Overly Permissive Security Groups

In the cloud, check what the network *allows*, not just what's listening today. Here's a quick AWS example that finds security groups permitting inbound TCP from anywhere:

```bash
aws ec2 describe-security-groups \
  --query "SecurityGroups[?IpPermissions[?(IpProtocol=='tcp' || IpProtocol=='-1') && IpRanges[?CidrIp=='0.0.0.0/0']]].[GroupId,GroupName]" \
  --output text
```

Then find which instances use them:

```bash
for sg in $(aws ec2 describe-security-groups \
  --query "SecurityGroups[?IpPermissions[?(IpProtocol=='tcp' || IpProtocol=='-1') && IpRanges[?CidrIp=='0.0.0.0/0']]].GroupId" \
  --output text); do
  aws ec2 describe-instances \
    --filters "Name=instance.group-id,Values=$sg" \
    --query "Reservations[].Instances[].[InstanceId,PrivateIpAddress,PublicIpAddress]" \
    --output text
done | sort -u
```

Azure NSGs and GCP firewall rules have equivalent queries. The idea is the same: find "any source, TCP" rules and the workloads behind them.

### Bucket the Results

Sort hosts into tiers:

| Tier | Criteria | Action window |
|------|----------|---------------|
| 0 | Internet-reachable TCP, unpatched kernel | Immediate |
| 1 | Reachable from broad internal networks (VPN, flat corp LAN, partner links) | Within days |
| 2 | Tightly segmented, few trusted sources | Normal emergency cycle |
| 3 | No inbound TCP from untrusted sources | Normal cycle, but still patch |

Tier 0 Ubuntu hosts are where the hard decisions are. We'll get to those.

## Step 2: Patch RHEL 8, 9, and 10

The fix exists, so the job is execution and verification.

### Confirm the Fix Is Visible to Your Hosts

First, check that each host's repos actually offer the fix. This matters if you use Satellite or a mirror that syncs on a schedule:

```bash
# Is there an advisory addressing this CVE available to this host?
dnf updateinfo list --cve CVE-2026-98432

# More detail, including the advisory ID and package versions
dnf updateinfo info --cve CVE-2026-98432
```

If that returns nothing on a RHEL 8, 9, or 10 host, suspect your content pipeline before assuming the host isn't affected. Sync your Satellite or mirror and re-check. Get the exact fixed kernel versions for each minor release, including EUS/AUS streams if you use them, from Red Hat's advisory. Don't hardcode versions from a blog post.

### Roll Out With Ansible

```yaml
# patch_rhel_kernel.yml
- name: Patch kernel for CVE-2026-98432
  hosts: rhel
  become: true
  serial: "20%"          # rolling, adjust to your tolerance
  max_fail_percentage: 5
  tasks:
    - name: Apply updates that address the CVE
      ansible.builtin.command: dnf -y update --cve CVE-2026-98432
      register: dnf_out
      changed_when: "'Nothing to do' not in dnf_out.stdout"

    - name: Check whether a reboot is required
      ansible.builtin.command: needs-restarting -r
      register: reboot_check
      failed_when: false
      changed_when: false

    - name: Reboot if needed
      ansible.builtin.reboot:
        reboot_timeout: 900
      when: reboot_check.rc == 1

    - name: Verify CVE is no longer listed as applicable
      ansible.builtin.command: dnf updateinfo list --cve CVE-2026-98432
      register: post_check
      changed_when: false
      failed_when: post_check.stdout | trim | length > 0
```

Some notes from doing this many times:

- **`serial` is your friend.** A kernel update plus reboot is where you find the host with a broken initramfs, a stale third-party module, or a hypervisor that's slow to bring the console back. Roll in waves.
- **Third-party kernel modules** such as storage drivers, security agents, and DKMS-built modules are the most common reason a patched host fails to boot cleanly. Patch a canary from each hardware or agent profile first.
- **Clustered services** need drain-and-reboot orchestration, not a blind `reboot`. Pacemaker, Kubernetes nodes, and database replicas all fall in this category. Fold those into your existing maintenance runbooks.

### Verify the Running Kernel

The most common failure in kernel patching is a host that *installed* the fix but is still *running* the old kernel. Check both:

```bash
# What's running
uname -r

# What will boot next
grubby --default-kernel

# Most recently installed kernel packages
rpm -q --last kernel kernel-core 2>/dev/null | head -3

# Confirm the CVE appears in the running kernel package's changelog
rpm -q --changelog kernel-core-$(uname -r) | grep -m1 CVE-2026-98432 \
  && echo "running kernel includes fix" \
  || echo "running kernel does NOT reference fix"
```

If `uname -r` doesn't match the newest installed kernel, the host hasn't rebooted into the fix and is still vulnerable. Your vulnerability scanner may disagree, because some scanners check installed packages, not the running kernel. Trust `uname -r`.

### What About kpatch?

If you have hosts that can't reboot soon, check whether Red Hat has released a kpatch live patch for this CVE. Confirm that in the advisory or the Customer Portal rather than assuming it. If one exists:

```bash
kpatch list
```

Treat a live patch as a bridge to a reboot, not a replacement for one.

## Step 3: Mitigate Ubuntu While Fixes Sit in Testing

This is the harder half. Canonical has fixed kernels, but they're in the opt-in testing channel. On Ubuntu, that's typically the `-proposed` pocket. They haven't reached `-updates` or `-security`, and there's no published date for when they will.

You have three levers. Use them together.

### Lever 1: Cut Network Exposure

Reducing exposure is the mitigation you control completely, today. Because the vulnerable code is in the core TCP stack, you can't blacklist a module or flip a feature off. What you *can* do is stop untrusted packets from reaching the stack.

**Upstream first.** Tighten security groups, NSGs, edge ACLs, and load balancer rules so Tier 0 hosts only accept TCP from sources that need it. Filtering upstream means hostile packets never touch the host.

**Host firewall as defense in depth.** Inbound packets pass through netfilter before local delivery to TCP, so dropping them in nftables keeps them out of the TCP receive path. The `raw` prerouting hook is the earliest point, ahead of connection tracking:

```nft
#!/usr/sbin/nft -f
# /etc/nftables.d/cve-2026-98432-mitigation.nft
# Restrict inbound IPv4 TCP to known-good sources while awaiting kernel fix.

table inet cve_mitigation {
    set trusted_v4 {
        type ipv4_addr
        flags interval
        elements = {
            10.0.0.0/8,          # internal (tighten this if you can)
            203.0.113.0/24       # example: partner or LB range, replace
        }
    }

    set public_tcp_ports {
        type inet_service
        elements = { 443 }       # only ports that truly must be public
    }

    chain prerouting_raw {
        type filter hook prerouting priority raw; policy accept;

        # Allow loopback
        iifname "lo" accept

        # Allow trusted sources to anything
        ip saddr @trusted_v4 accept

        # Allow the minimal set of truly public services
        tcp dport @public_tcp_ports accept

        # Allow return traffic for outbound connections the host starts.
        # conntrack isn't available at raw priority, so match on flags:
        # drop untrusted inbound SYNs (new connections), let the rest through.
        ip protocol tcp tcp flags & (syn | ack) == syn drop
    }
}
```

One important caveat. This ruleset blocks **new inbound connections** from untrusted sources. It doesn't block every TCP packet, because return traffic for outbound connections still has to get in. If the advisory shows the bug is reachable by non-SYN packets, such as crafted segments that don't belong to an existing connection, you'll need stricter filtering. One way is to add a `filter`-priority chain that uses conntrack to drop untrusted TCP in the `invalid` or `new` states. Read the advisory, then tune the rules.

Apply it carefully. Locking yourself out of SSH on a remote box is a bad afternoon:

```bash
# Syntax check first
sudo nft -c -f /etc/nftables.d/cve-2026-98432-mitigation.nft

# Apply with a safety net: auto-revert in 5 minutes unless you cancel
sudo nft -f /etc/nftables.d/cve-2026-98432-mitigation.nft && \
  (sleep 300 && sudo nft delete table inet cve_mitigation) &
# ...verify you still have access, then:
kill %1
```

If you manage firewalls through `ufw`, make the equivalent change there instead of mixing tools. Two systems fighting over netfilter is how mitigations silently disappear after a reboot.

**For services that must stay public**, put them behind something that terminates TCP, such as a cloud load balancer, CDN, or reverse proxy tier. Then the Ubuntu host only sees connections from that tier. This won't help if the proxy tier itself runs a vulnerable kernel, so check that too.

### Lever 2: Check Live Patch Coverage

If your Ubuntu hosts are enrolled in Ubuntu Pro with Livepatch, check whether a live patch covers this CVE. Don't assume it does. Confirm it in Canonical's CVE tracker or security notice for CVE-2026-98432.

```bash
# Livepatch state and which fixes are applied
canonical-livepatch status --verbose

# Ubuntu Pro's view of this CVE on this host
pro fix CVE-2026-98432 --dry-run
```

`pro fix` is useful because it reports what Canonical considers the remediation path *for that specific host*. That can differ across releases and kernel flavors.

### Lever 3: Selectively Use the Testing Channel for Tier 0

This is a judgment call, and I want to be direct about the trade-off. Testing-channel kernels haven't finished Canonical's normal validation. Running them in production carries some risk of regressions. Leaving a Tier 0, internet-facing host exposed to a 9.8-rated remote kernel bug also carries risk. For a small set of hosts that can't be shielded at the network layer, I'd usually take the testing kernel, on these conditions:

- Install **only** the kernel packages from `-proposed`, not everything.
- Canary it on a representative host first.
- Keep the previous kernel installed so you can boot back into it.
- Plan to move back to the regular channel as soon as the fix lands there.

**Pin `-proposed` so nothing else comes from it by accident:**

```bash
CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")

# Low priority: never auto-install from proposed
sudo tee /etc/apt/preferences.d/proposed-pin >/dev/null <<EOF
Package: *
Pin: release a=${CODENAME}-proposed
Pin-Priority: 100
EOF
```

**Enable the pocket.** On newer releases using deb822-format sources:

```bash
sudo tee /etc/apt/sources.list.d/ubuntu-proposed.sources >/dev/null <<EOF
Types: deb
URIs: http://archive.ubuntu.com/ubuntu/
Suites: ${CODENAME}-proposed
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
EOF

sudo apt update
```

**Identify your kernel flavor before installing anything.** This step trips people up. A host on `linux-aws`, `linux-azure`, `linux-gcp`, or an HWE kernel needs that flavor's packages, not `linux-generic`:

```bash
dpkg -l 'linux-image-*' | awk '/^ii/{print $2, $3}'
uname -r
```

**See what `-proposed` offers for your flavor, and confirm it contains the fix:**

```bash
FLAVOR_META=linux-generic   # or linux-aws, linux-azure, linux-generic-hwe-XX.XX, etc.

apt-cache policy "$FLAVOR_META"
apt changelog -t "${CODENAME}-proposed" "$FLAVOR_META" 2>/dev/null | head -50
```

Check the underlying kernel image's changelog for the CVE, or cross-check the version against Canonical's CVE tracker. The only reason to take a testing kernel is that it contains the fix, so verify that before installing.

**Install only the kernel meta packages from `-proposed`:**

```bash
sudo apt install -t "${CODENAME}-proposed" "$FLAVOR_META"
sudo reboot
```

After the reboot:

```bash
uname -r
# Confirm the running kernel matches the proposed version you validated
```

Once the fix reaches the regular channel, remove the `-proposed` source and pin file. Normal updates will then move you onto the officially released kernel.

### Ubuntu Decision Matrix

| Host situation | Recommended approach |
|---|---|
| Can be fully firewalled from untrusted TCP | Network mitigation, wait for regular update |
| Must stay public, can be fronted by a proxy or LB | Front it, firewall direct access, wait for regular update |
| Must stay directly public, live patch available | Apply live patch, plus network hardening |
| Must stay directly public, no live patch | Canary, then testing-channel kernel with pinning |

## Step 4: Track to Closure

An emergency kernel patch isn't done when the playbook finishes. It's done when every host is *running* a fixed kernel. A few practices help.

**Measure running state, not installed state.** Here's a simple fleet-wide check you can schedule daily:

```bash
#!/usr/bin/env bash
# report_kernel_state.sh: run via Ansible ad-hoc or your config mgmt tool
source /etc/os-release
running=$(uname -r)

case "$ID" in
  rhel|centos|rocky|almalinux)
    if rpm -q --changelog "kernel-core-${running}" 2>/dev/null | grep -q CVE-2026-98432; then
      status=fixed
    else
      status=VULNERABLE
    fi ;;
  ubuntu)
    # Defer to Ubuntu Pro's assessment where available
    if pro fix CVE-2026-98432 --dry-run 2>/dev/null | grep -qi "is resolved"; then
      status=fixed
    else
      status=CHECK
    fi ;;
  *) status=UNKNOWN ;;
esac

echo "$(hostname),$ID,$VERSION_ID,$running,$status"
```

The Ubuntu branch reports `CHECK` rather than `VULNERABLE` because the exact wording of `pro fix` output can change between client versions. Validate the match string against your environment before you build dashboards on it.

**Watch the Ubuntu channel.** Subscribe to Ubuntu Security Notices and watch Canonical's CVE tracker entry for CVE-2026-98432. When the status changes from testing to released, that triggers your normal emergency patch run.

**Don't remove network mitigations too early.** Once a host is confirmed running a fixed kernel, you can relax the temporary nftables rules and security group changes. Do it deliberately. Some of those "temporary" restrictions are probably worth keeping, since you've just found exposure you didn't need.

## Takeaways

- **Kernel network bugs make every port count.** Your exposure inventory, covering listeners, external reachability, and firewall rules, decides how fast you can respond. Build it before the next one.
- **Patch RHEL now and verify with `uname -r`.** Installed is not fixed. Running is fixed.
- **On Ubuntu, network mitigation is the main defense while you wait.** Upstream filtering is best, and host nftables in the raw hook is good defense in depth. Tune both once the trigger conditions are clearer.
- **Using the testing channel is a deliberate risk trade-off, not a default.** Limit it to Tier 0 hosts you can't shield, pin it tightly, match your kernel flavor, and move back to the regular channel when the fix ships.
- **Get specifics from the advisories.** Fixed package versions, live patch availability, IPv6 impact, and exploitation status should come from Red Hat and Canonical, not from assumptions or second-hand summaries.

The teams that handle incidents like this smoothly are the ones that made fleet inventory, rolling reboots, and network segmentation routine before they needed them. This is a good week to find out how ready yours are.

## Sources

- [Red Hat Patches 9.8-Rated Linux TCP RCE Flaw While Ubuntu Releases Fixes for Testing](https://thehackernews.com/2026/11/red-hat-patches-98-rated-linux-tcp-rce.html) (2026-11-03)
