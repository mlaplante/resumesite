---
title: "Ghostscript Sandbox Escape Through File Uploads: Find, Patch, and Hunt"
date: 2026-11-22
category: "thought-leadership"
tags: ["ghostscript", "vulnerability-management", "threat-hunting", "linux", "appsec"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "Ask most application teams whether they run Ghostscript and you'll get a blank stare, or a confident \"no.\" Then ask whether they generate thumbnails..."
---

Ask most application teams whether they run Ghostscript and you'll get a blank stare, or a confident "no." Then ask whether they generate thumbnails for uploaded images, preview PDFs, or let users attach documents. That answer is almost always "yes."

That gap is the problem. This week, security firm pwn.ai demonstrated that ordinary upload features in popular applications can be abused through a now-patched Ghostscript flaw. A crafted file escapes Ghostscript's security sandbox and runs commands on the server that processes it. Ghostscript is the interpreter many Linux servers use to convert uploaded PDFs, PostScript files, and images into other formats, and the application often never calls it directly.

I'm not going to speculate about the specific bug. The published details are limited. **Get the fixed version numbers, affected releases, and any CVE identifier from the Ghostscript and distribution advisories rather than from blog posts, including this one.** What I can give you is the operational playbook: how to find Ghostscript where it's hiding, patch it properly, cut the attack surface so the next sandbox bypass doesn't burn you, and hunt for signs that someone got there first.

## Why This Class of Bug Keeps Coming Back

Ghostscript is not a simple file parser. It is a full interpreter for PostScript, a Turing-complete programming language. When your server "converts an EPS to PNG," it is executing a program supplied by an anonymous user.

The `-dSAFER` sandbox exists to limit what that program can do: no arbitrary file access, no spawning processes, no output to pipes. Modern releases enable SAFER by default. Over the years, though, researchers have repeatedly found ways out of it. When the sandbox fails, the attacker gets code execution as whatever user runs your conversion worker.

Three properties make this especially dangerous in upload pipelines:

1. **Content sniffing beats extension checks.** ImageMagick and similar libraries detect format from file contents, not the filename. A file named `avatar.jpg` that starts with `%!PS` will be handed to Ghostscript.
2. **The call is indirect.** Your code calls `Image.open()` or `$imagick->readImage()`. The library calls a delegate. The delegate calls `gs`. No one on the team ever typed "Ghostscript."
3. **Processing happens automatically.** Thumbnailing, metadata extraction, and preview generation often run the moment a file lands, before any human or AV scanner sees it.

## Step 1: Find Every Place Ghostscript Lives

Your inventory will be wrong at first. Assume it is and check from several angles.

### On hosts: packages, binaries, and libraries

Start with the package manager, then look for anything installed outside it:

```bash
# Debian/Ubuntu
dpkg -l | grep -Ei 'ghostscript|libgs'
apt-cache rdepends --installed ghostscript libgs10 2>/dev/null

# RHEL/Fedora/Rocky
rpm -qa | grep -i ghostscript
rpm -q --whatrequires ghostscript

# Alpine
apk info -v | grep -i ghostscript

# Anything vendored or hand-installed
find / -xdev -type f \( -name 'gs' -o -name 'gsc' -o -name 'libgs.so*' \) 2>/dev/null

# What version is actually on PATH?
command -v gs && gs --version
```

The reverse-dependency queries are where the surprises show up: ImageMagick, GraphicsMagick, print filters, OCR tooling, document management stacks. Package names vary by distro and release. The `libgs10` above is an example, so adjust for your systems.

### In containers: where the real exposure usually is

Base images pull in ImageMagick "just in case," and ImageMagick pulls in Ghostscript. Scan the images you actually deploy, not just the hosts:

```bash
# Generate an SBOM and look for ghostscript
syft registry.example.com/media-worker:prod -q | grep -i ghostscript

# Or just ask the image directly
docker run --rm --entrypoint sh registry.example.com/media-worker:prod \
  -c 'command -v gs && gs --version; ls /usr/lib/*/libgs.so* 2>/dev/null'
```

If you have a registry with built-in scanning, query it for the Ghostscript package across every repository. You want a list of images, the services that run them, and whether those services touch user uploads.

### In ImageMagick: the delegate path

ImageMagick hands PostScript-family formats to Ghostscript through its delegate configuration:

```bash
# Which delegates are configured?
convert -list delegate 2>/dev/null | grep -iE 'gs|ghostscript'
magick -list delegate 2>/dev/null | grep -iE 'gs|ghostscript'

# Where's the config?
convert -list configure | grep -i 'CONFIGURE_PATH'
grep -n '"gs"\|gs ' /etc/ImageMagick-*/delegates.xml

# What does the current security policy allow?
identify -list policy
```

If `-list policy` shows nothing restricting PS, EPS, PDF, or XPS, then any image upload path backed by ImageMagick is a Ghostscript upload path.

### In code: the indirect callers

Grep your repositories for libraries that commonly reach Ghostscript:

```bash
rg -n --hidden -i \
  -e 'ghostscript' -e '\bgs\b.*-sDEVICE' \
  -e 'EpsImagePlugin' -e 'Image\.open' \
  -e 'Imagick' -e 'MiniMagick' -e 'wand\.image' -e 'RMagick' \
  -e 'gm convert' -e 'subprocess.*convert' \
  .
```

A few known paths:

- **Python Pillow:** the EPS plugin shells out to Ghostscript. A bare `Image.open()` on an untrusted file can reach it.
- **PHP Imagick, Ruby MiniMagick/RMagick, Python Wand:** all wrap ImageMagick, which uses Ghostscript delegates.
- **GraphicsMagick:** also delegates PostScript-family formats to Ghostscript.
- **OCR and PDF processing pipelines:** many use Ghostscript for rasterization or PDF normalization.
- **Print and document filters:** CUPS filter chains frequently invoke Ghostscript.

### At runtime: catch what static analysis missed

Static inventory misses dynamic invocations. Put a short-term execution watch on the binary and see who calls it:

```bash
# auditd: log every execution of gs
auditctl -w /usr/bin/gs -p x -k ghostscript_exec

# A day later, see who's calling it
ausearch -k ghostscript_exec -i | grep -E 'exe=|ppid=|comm='
```

Correlate the parent PIDs back to services. Any web-facing service in that list needs attention today.

One caveat: some builds link `libgs` directly into the calling process instead of executing `gs`. Check for that too:

```bash
grep -l 'libgs.so' /proc/[0-9]*/maps 2>/dev/null | \
  sed 's#/proc/\([0-9]*\)/maps#\1#' | xargs -r ps -o pid,user,comm,args -p
```

## Step 2: Patch, Then Prove the Patch Took

Pull the fixed version from the Ghostscript project's advisory or your distribution's security tracker. Don't guess at version numbers.

```bash
# Debian/Ubuntu
sudo apt-get update && sudo apt-get install --only-upgrade ghostscript 'libgs*'

# RHEL family
sudo dnf upgrade ghostscript

# Alpine
apk upgrade ghostscript
```

Upgrading the package is not the same as being patched. Long-running workers that loaded the old `libgs` keep using it until they restart. Find processes still mapping deleted library files:

```bash
grep -l 'libgs.so.*(deleted)' /proc/[0-9]*/maps 2>/dev/null | \
  sed 's#/proc/\([0-9]*\)/maps#\1#' | xargs -r ps -o pid,comm,args -p

# Or, on Debian-family systems
sudo needrestart -r l
```

For containers, patching the host does nothing. Rebuild the image from an updated base, redeploy, and confirm in the running container:

```bash
kubectl exec deploy/media-worker -- gs --version
```

Compare that output against the fixed version listed in the advisory. Record it in your ticket. "We upgraded" without evidence is how a stale image survives for six months.

## Step 3: Shrink the Attack Surface So the Next Bypass Hurts Less

Patching closes this hole. Ghostscript's history says there will be another one. The durable fix is to stop feeding untrusted PostScript to an interpreter at all, unless the business truly requires it.

### Lock down ImageMagick with a policy

Most applications that thumbnail avatars have no reason to process PostScript, EPS, or XPS. Disable those coders in `policy.xml`:

```xml
<policymap>
  <!-- Block PostScript-family formats that route through Ghostscript -->
  <policy domain="coder" rights="none" pattern="{PS,PS2,PS3,EPS,EPSF,EPSI,EPI,EPT,XPS,PCL}" />
  <!-- Block PDF too, unless you have a hard requirement (see below) -->
  <policy domain="coder" rights="none" pattern="PDF" />

  <!-- Sensible resource limits while you're here -->
  <policy domain="resource" name="memory" value="256MiB"/>
  <policy domain="resource" name="time" value="30"/>
</policymap>
```

Newer ImageMagick versions also support a `delegate` policy domain, which lets you deny the Ghostscript delegate outright. Check your version's documentation before relying on it.

Then verify, because a misplaced policy file fails silently:

```bash
printf '%%!PS\n/Helvetica findfont 12 scalefont setfont 72 72 moveto (test) show showpage\n' > /tmp/probe.eps
convert /tmp/probe.eps /tmp/probe.png
# Expected: "not authorized `EPS'" or similar. If you get a PNG, the policy isn't loaded.
```

### Allowlist formats in application code

In Pillow, restrict which decoders `open()` will try:

```python
from PIL import Image

ALLOWED_FORMATS = ["JPEG", "PNG", "GIF", "WEBP"]

def open_untrusted_image(path: str) -> Image.Image:
    # Pillow will refuse anything not in the allowlist, including EPS,
    # regardless of file extension.
    img = Image.open(path, formats=ALLOWED_FORMATS)
    img.verify()                     # structural check
    return Image.open(path, formats=ALLOWED_FORMATS)  # reopen after verify()
```

For ImageMagick wrappers, validate magic bytes yourself before the library touches the file. Don't call `identify` to "check the type first." On a PostScript file, `identify` can invoke Ghostscript itself.

```python
MAGIC = {
    b"\xFF\xD8\xFF": "jpeg",
    b"\x89PNG\r\n\x1a\n": "png",
    b"GIF87a": "gif",
    b"GIF89a": "gif",
}
DANGEROUS_PREFIXES = (b"%!", b"%PDF", b"\xC5\xD0\xD3\xC6")  # PS, PDF, binary EPS

def sniff(path: str) -> str:
    with open(path, "rb") as f:
        head = f.read(16)
    if head.startswith(DANGEROUS_PREFIXES):
        raise ValueError("PostScript/PDF content rejected")
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    for sig, kind in MAGIC.items():
        if head.startswith(sig):
            return kind
    raise ValueError("unrecognized format")
```

Then pass the format explicitly (for example, `png:/path/to/file` in ImageMagick) so the library can't re-sniff its way into a different coder.

### If you genuinely need PDF previews

Some products need PDF thumbnails. Consider rendering them with a tool that isn't a PostScript interpreter, such as `pdftoppm` from Poppler. Poppler has its own parser bugs, so it still needs isolation (next section). The difference is that it doesn't execute an attacker-supplied program by design, and that difference matters.

## Step 4: Isolate Whatever Still Processes Untrusted Files

Assume the converter will eventually be compromised, and make that compromise boring.

### A throwaway container per job

```bash
docker run --rm \
  --network none \
  --read-only \
  --tmpfs /tmp:rw,size=64m,noexec \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --user 65534:65534 \
  --memory 512m --pids-limit 64 --cpus 1 \
  -v "$JOB_DIR:/work:rw" \
  converter:pinned \
  timeout 30 gs -dSAFER -dBATCH -dNOPAUSE -dQUIET \
    -sDEVICE=png16m -r72 -dFirstPage=1 -dLastPage=1 \
    -sOutputFile=/work/out.png /work/in.pdf
```

No network means no reverse shell and no second-stage download. A read-only root with a non-root user leaves nothing worth persisting to. `--pids-limit` and `timeout` blunt fork bombs and infinite loops. PostScript can loop forever, and it's legal for it to do so.

Keep `-dSAFER` explicit even though it's the default. It documents intent and protects you if someone builds against an older or oddly configured release.

### Lighter weight: bubblewrap

If spinning up containers per file is too heavy, `bwrap` gives you namespaces with minimal overhead:

```bash
bwrap \
  --ro-bind /usr /usr --ro-bind /etc/fonts /etc/fonts \
  --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 \
  --proc /proc --dev /dev --tmpfs /tmp \
  --bind "$JOB_DIR" /work --chdir /work \
  --unshare-all --die-with-parent --new-session \
  prlimit --as=536870912 --nproc=32 -- \
  timeout 30 gs -dSAFER -dBATCH -dNOPAUSE -sDEVICE=png16m -r72 \
    -dFirstPage=1 -dLastPage=1 -sOutputFile=/work/out.png /work/in.pdf
```

`--unshare-all` includes the network namespace, so the process has no network access. Adjust the bind mounts to your distro's filesystem layout.

### Harden the long-running worker too

If your worker is a systemd service, add these to the unit file. They cost nothing:

```ini
[Service]
User=mediaworker
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ReadWritePaths=/var/lib/mediaworker/jobs
RestrictAddressFamilies=AF_UNIX
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @mount
CapabilityBoundingSet=
```

`RestrictAddressFamilies=AF_UNIX` is the heavy hitter. If the worker only needs a local queue socket, it never needs to open TCP connections, and an attacker who escapes Ghostscript can't open them either.

## Step 5: Hunt for Evidence You Were Already Hit

The patch is now public, which means the technique is effectively public. If you had exposed upload paths, look back as well as forward.

### Process lineage: Ghostscript should never spawn a shell

Under normal operation, `gs` reads input and writes output. It doesn't launch `sh`, `curl`, or `python`. A Falco rule for this:

```yaml
- rule: Suspicious Child of Ghostscript
  desc: Ghostscript (directly or via an image library) spawned a shell or network tool
  condition: >
    spawned_process and
    (proc.pname in (gs, gsc) or proc.aname[2] in (gs, gsc)) and
    proc.name in (sh, bash, dash, zsh, curl, wget, nc, ncat, python, python3, perl, ruby, php)
  output: >
    Ghostscript child process (user=%user.name cmd=%proc.cmdline
    parent=%proc.pname gparent=%proc.aname[2] container=%container.name)
  priority: CRITICAL
  tags: [rce, ghostscript, upload]
```

Remember the `libgs` caveat: if Ghostscript runs in-process, the parent is your app (`php-fpm`, `python3`, `ruby`). Add a companion rule for shells spawned by those image-processing workers, scoped to their containers.

For a point-in-time sweep with osquery:

```sql
SELECT p.pid, p.name, p.cmdline, p.uid,
       pp.name AS parent, pp.cmdline AS parent_cmd
FROM processes p
JOIN processes pp ON p.parent = pp.pid
WHERE pp.name IN ('gs', 'gsc', 'convert', 'magick', 'gm')
  AND p.name NOT IN ('gs', 'gsc');
```

If you have `process_events` enabled, run the same logic against historical events for the window between when the flaw became exploitable (check the advisory) and when you patched.

### Look at what was uploaded

Scan upload storage for PostScript content wearing an image costume, plus strings that historical Ghostscript exploits have commonly abused:

```python
#!/usr/bin/env python3
import os, sys

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"}
PS_HEADERS = (b"%!", b"\xC5\xD0\xD3\xC6")
SUSPICIOUS = (b"%pipe%", b"/OutputFile", b"(%pipe%", b".forceput", b"/PermitFileWriting")

root = sys.argv[1]
for dirpath, _, files in os.walk(root):
    for name in files:
        path = os.path.join(dirpath, name)
        try:
            with open(path, "rb") as f:
                data = f.read(256 * 1024)
        except OSError:
            continue
        ext = os.path.splitext(name)[1].lower()
        reasons = []
        if data.startswith(PS_HEADERS) and ext in IMAGE_EXTS:
            reasons.append("postscript-with-image-extension")
        hits = [s.decode() for s in SUSPICIOUS if s in data]
        if hits:
            reasons.append("strings:" + ",".join(hits))
        if reasons:
            print(f"{path}\t{';'.join(reasons)}")
```

This is a heuristic, not a signature for this specific bug. Treat hits as leads. Hash them, preserve them, and **don't open them on an analyst workstation that has Ghostscript installed**. Previewing a sample in your file manager can trigger the same chain.

### Check the usual post-exploitation footprints

On every host or container that processed uploads:

- **Outbound connections from worker processes.** Pull VPC flow logs or egress proxy logs for the worker subnets. Image converters rarely have a legitimate reason to talk to the internet.
- **New files in writable paths:** `/tmp`, `/var/tmp`, `/dev/shm`, upload directories, and web roots. Look for scripts, ELF binaries, or web shells.
- **Persistence:** crontabs for the worker user, systemd user units, `~/.ssh/authorized_keys`, and modified startup scripts.
- **Credential access:** the worker's environment variables, mounted secrets, and cloud instance metadata. If the worker could reach a metadata endpoint, assume any role credentials it held may be exposed. Rotate them, and review cloud audit logs for their use from unexpected sources.

## The Checklist

If you only have an hour today, do these in order:

1. **Inventory:** run the package, container, and delegate checks above. List every service that touches user uploads and has Ghostscript reachable.
2. **Patch:** upgrade to the fixed release from the vendor advisory, restart processes still holding the old library, rebuild container images, and verify with `gs --version`.
3. **Disable:** deny PS, EPS, XPS, and (if possible) PDF in ImageMagick's `policy.xml`. Allowlist formats in Pillow. Sniff magic bytes before any library touches the file.
4. **Isolate:** run conversions with no network, a read-only filesystem, a non-root user, and hard resource limits.
5. **Hunt:** alert on shells spawned under Ghostscript, scan upload storage for disguised PostScript, and review egress from worker hosts.

## The Bigger Lesson

What this research highlights is the gap between what your SBOM says and what your threat model assumes. Teams patch the things they know they run. Ghostscript sits two or three layers down a call chain, invoked by a library, triggered by a feature nobody thinks of as security-sensitive. Thumbnailing an avatar doesn't feel like executing attacker code, but with PostScript in the mix, that is effectively what happens.

Treat every component that parses untrusted input as an execution environment: inventory it, constrain it, and watch what it spawns. Do that, and the next sandbox bypass becomes a routine patch cycle instead of an incident.

## Sources

- [Researchers Demonstrate Ghostscript Sandbox-Escape RCE via Crafted File Uploads in Popular Apps](https://thehackernews.com/2026/11/researchers-demonstrate-ghostscript.html) (2026-11-22)
