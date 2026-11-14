---
title: "Patching PostgreSQL's 22-Year-Old Type Confusion RCE the Right Way"
date: 2026-11-14
category: "thought-leadership"
tags: ["postgresql", "database-security", "vulnerability-management", "patching", "linux-hardening"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "Most database patches are routine: read the release notes, schedule a maintenance window, bump the package, restart, move on. CVE-2026-6460 needs more..."
---

Most database patches are routine: read the release notes, schedule a maintenance window, bump the package, restart, move on. CVE-2026-6460 needs more than that. For full protection, the binary upgrade alone is not enough.

The PostgreSQL project has released updates that fix 52 security flaws. The most serious is a type confusion bug that has existed in the codebase for roughly 22 years. It lets a database user who can create objects run code on the server, with the privileges of the operating system account PostgreSQL runs as. It carries a CVSS score of 8.8. The advisory includes one detail that many teams will miss: **full protection also requires rebuilding any C-language extensions installed on the server.**

So this is a four-part job, not a one-line `apt upgrade`:

1. Find every PostgreSQL server you own, including the ones nobody remembers.
2. Patch them.
3. Rebuild and redeploy every C extension against the patched headers.
4. Restrict who can create objects, so the next bug of this kind has fewer users who can trigger it.

Below is how I'd run each step, with the queries and scripts I'd actually use.

## What We Know and What We Don't

The reported facts are short:

- **Vulnerability class:** type confusion
- **Precondition:** an authenticated database user with the ability to create objects
- **Impact:** code execution on the database host as the OS user running PostgreSQL
- **Severity:** CVSS 8.8
- **Age:** roughly 22 years, so it almost certainly affects every supported major version
- **Remediation:** apply the update *and* rebuild C-language extensions
- **Context:** shipped together with fixes for 51 other security issues

Several things are **not** in the public summary, and you should check them in the official PostgreSQL security advisory rather than guess:

- The exact fixed minor version for each supported major branch
- Which object types or SQL constructs trigger the bug
- Whether specific privileges such as `TEMPORARY` are enough to exploit it
- The precise reason extensions need rebuilding

My working assumption on that last point: the fix probably changes code that extensions compile into their own binaries, such as header macros or inline functions. Those copies don't update when you swap the server binary. I haven't confirmed that, but it fits the guidance, and it changes how you verify your work. I come back to it in Step 3.

## Why "Authenticated" Is Not Comforting

When people see "requires authentication," they tend to lower the priority. Don't do that here. In real environments, "a user who can create objects" covers a lot of accounts:

- **Application service accounts** that own their schema because the ORM runs migrations at startup. This is very common.
- **SQL injection.** Any injectable endpoint running as a role with `CREATE` gives an outsider a route to host-level code execution.
- **Shared analytics or BI credentials** that sit in notebooks, dashboards, and many people's laptops.
- **Multi-tenant platforms** where customers get their own schema or database.
- **CI/CD pipelines** that hold migration credentials. If a pipeline is compromised, the attacker gets those credentials too.
- **Clusters upgraded from before PostgreSQL 15**, where `PUBLIC` may still have `CREATE` on the `public` schema. In that case, *every* role that can log in can create objects.

That last case is the one that worries me most, and I explain why in Step 4.

The result of exploitation also matters. Code running as the `postgres` OS user can read the entire data directory, bypass every row-level security policy and every `GRANT`, and access any credentials that account can reach. That includes `.pgpass` files, WAL archiving credentials for object storage, and replication secrets. In practice, this is full compromise of the database.

## Step 1: Find Every PostgreSQL Server

You can't patch servers you don't know about. CMDB data is a starting point, but treat it as a hint and confirm it against what's actually running.

### Network sweep

PostgreSQL usually listens on 5432, but non-default ports are common, especially for secondary clusters and connection poolers. Scan the default and a few common alternatives, and use service detection so you aren't relying on port numbers alone:

```bash
# Internal sweep: adjust ranges and ports to your environment
nmap -sV -p 5432-5440,6432,15432 --open \
  -oG pg-sweep.gnmap 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16

# Extract hosts where service detection identified PostgreSQL
grep -i postgresql pg-sweep.gnmap | awk '{print $2}' | sort -u > pg-hosts.txt
wc -l pg-hosts.txt
```

Run the same sweep from an external vantage point against your public IP space. Any PostgreSQL port reachable from the internet should be treated as a priority incident, not just a patching task.

### Cloud inventory

Managed databases are easy to forget because nobody logs into the host. For AWS RDS and Aurora, for example:

```bash
for region in $(aws ec2 describe-regions --query 'Regions[].RegionName' --output text); do
  aws rds describe-db-instances --region "$region" \
    --query "DBInstances[?starts_with(Engine, 'postgres') || starts_with(Engine, 'aurora-postgresql')].[DBInstanceIdentifier,Engine,EngineVersion,PubliclyAccessible]" \
    --output text | sed "s/^/$region\t/"
done
```

For managed services, the provider handles the binary patch and, presumably, the extensions it ships. Confirm their timeline and whether their bundled extensions are rebuilt. The `CREATE` privilege lockdown in Step 4 still applies to you, because the provider doesn't control your role design.

### Containers and Kubernetes

Look for PostgreSQL images that nobody is tracking as a "database":

```bash
kubectl get pods -A -o jsonpath='{range .items[*]}{.metadata.namespace}{"\t"}{.metadata.name}{"\t"}{range .spec.containers[*]}{.image}{" "}{end}{"\n"}{end}' \
  | grep -Ei 'postgres|postgis|timescale|pgvector|citus'
```

Expect to find sidecar databases, Helm chart dependencies that quietly deploy their own PostgreSQL, and test environments that ended up in production.

### Version fingerprinting

Once you have a host list, get the actual running version. The package version on disk isn't proof, because a server that hasn't been restarted is still running the old binary:

```bash
while read -r host; do
  v=$(PGCONNECT_TIMEOUT=5 psql "host=$host user=inventory dbname=postgres sslmode=prefer" \
      -Atc "SHOW server_version_num" 2>/dev/null)
  printf '%s\t%s\n' "$host" "${v:-UNREACHABLE}"
done < pg-hosts.txt | tee pg-versions.tsv
```

`server_version_num` returns an integer that sorts cleanly. Compare it against the fixed minor version for each major branch, which you should take from the advisory.

### Exposure on each host

On each host, check what the server listens on and who it accepts connections from:

```sql
SHOW listen_addresses;

-- PostgreSQL 10+: parsed view of pg_hba.conf, including errors
SELECT line_number, type, database, user_name, address, netmask, auth_method
FROM pg_hba_file_rules
ORDER BY line_number;
```

Any rule with `0.0.0.0/0`, `::/0`, or `trust` should be looked at today, regardless of this CVE.

## Step 2: Patch the Server

Minor version updates in PostgreSQL don't change the on-disk format, so you don't need `pg_upgrade` or a dump and restore. You do need a restart, because the running postmaster keeps executing the old binary until it's restarted.

### Package-based installs

```bash
# Debian/Ubuntu (PGDG repo): replace <major> with your major version
sudo apt-get update
sudo apt-get install --only-upgrade postgresql-<major> postgresql-client-<major> \
     postgresql-server-dev-<major>   # include -dev if you build extensions here
sudo systemctl restart postgresql@<major>-main

# RHEL family (PGDG repo)
sudo dnf upgrade 'postgresql<major>*'
sudo systemctl restart postgresql-<major>
```

Upgrade the `-dev` / `-devel` package along with the server. That's where the headers come from, and you need the patched headers for Step 3.

### HA clusters

With Patroni or a similar tool, do a rolling upgrade: patch and restart the replicas first, perform a controlled switchover, then patch the old primary.

```bash
patronictl -c /etc/patroni/patroni.yml list
# Patch packages on each replica, then:
patronictl -c /etc/patroni/patroni.yml restart <cluster> <replica-member> --force
# After all replicas are patched:
patronictl -c /etc/patroni/patroni.yml switchover <cluster> --candidate <patched-replica> --force
# Then patch and restart the former primary
```

### Containers

Rebuild from the patched upstream base image and pin it by digest. Floating major-version tags only get the fix when the image is rebuilt and the pod is restarted. A pod that's been running for 90 days on `postgres:<major>` is still on whatever that tag pointed to 90 days ago.

### Verify

```sql
SELECT version(), current_setting('server_version_num');
SELECT pg_postmaster_start_time();  -- should be after your maintenance window
```

## Step 3: Rebuild C-Language Extensions

This is the step most teams will skip, and I think the advisory calls it out for exactly that reason.

### Inventory what's actually loaded

Start with installed extensions:

```sql
SELECT extname, extversion FROM pg_extension ORDER BY 1;
```

That list misses things. Standalone C functions that aren't packaged as extensions don't appear in it, and neither do libraries loaded through configuration. To find every shared library your catalogs reference, run this in **every database**, because `pg_proc` is per-database:

```sql
SELECT p.probin AS library,
       count(*)  AS function_count,
       string_agg(DISTINCT n.nspname, ', ') AS schemas
FROM pg_proc p
JOIN pg_language  l ON l.oid = p.prolang
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE l.lanname = 'c'
  AND p.probin IS NOT NULL
GROUP BY p.probin
ORDER BY p.probin;
```

Then check the configuration-loaded libraries, which never appear in `pg_proc`:

```sql
SELECT name, setting
FROM pg_settings
WHERE name IN ('shared_preload_libraries',
               'session_preload_libraries',
               'local_preload_libraries')
  AND setting <> '';
```

### Find stale binaries on disk

A quick and useful check is to list every `.so` in the package library directory that is older than the patched `postgres` binary:

```bash
PGCONFIG=/usr/lib/postgresql/<major>/bin/pg_config   # adjust path
LIBDIR=$($PGCONFIG --pkglibdir)
POSTGRES_BIN=$($PGCONFIG --bindir)/postgres

echo "Server binary: $(stat -c '%y' "$POSTGRES_BIN")"
find "$LIBDIR" -name '*.so' ! -newer "$POSTGRES_BIN" -printf '%TY-%Tm-%Td  %p\n' | sort
```

This catches a lot but not everything. Core contrib modules ship in the same package as the server, so they'll have new timestamps. Anything that comes from a separate package, a vendor tarball, or a `make install` someone ran two years ago will show up here.

### Distro-packaged extensions

For extensions from PGDG or your distro (PostGIS, pgvector, TimescaleDB, and so on), the packager has to publish rebuilt packages. Check whether they have, then upgrade:

```bash
# Debian/Ubuntu: what extension packages do we have?
dpkg -l | awk '/postgresql-<major>-/ {print $2, $3}'
```

If a rebuilt package isn't available yet, **write that down as an open risk**. Don't mark the server remediated. You can rebuild from source in the meantime, or schedule a recheck.

### Custom and in-house extensions

Build these against the patched headers with PGXS. Point at the correct `pg_config` explicitly. Hosts with multiple PostgreSQL versions installed often build against the wrong one:

```bash
cd /src/our_extension
make USE_PGXS=1 PG_CONFIG=/usr/lib/postgresql/<major>/bin/pg_config clean
make USE_PGXS=1 PG_CONFIG=/usr/lib/postgresql/<major>/bin/pg_config
sudo make USE_PGXS=1 PG_CONFIG=/usr/lib/postgresql/<major>/bin/pg_config install
```

If you build extensions in CI and ship them as packages or baked into images, which you should, add a guard so the build fails against unpatched headers:

```bash
#!/usr/bin/env bash
set -euo pipefail
PG_CONFIG=${PG_CONFIG:-pg_config}
MIN_VERSION_NUM="${MIN_PG_VERSION_NUM:?set from the advisory per major branch}"

# pg_config --version prints e.g. "PostgreSQL 16.x"; derive a comparable number
ver=$($PG_CONFIG --version | awk '{print $2}')
major=${ver%%.*}; minor=${ver#*.}; minor=${minor%%[^0-9]*}
num=$(( major * 10000 + minor ))

if (( num < MIN_VERSION_NUM )); then
  echo "Refusing to build against PostgreSQL $ver (< required $MIN_VERSION_NUM)" >&2
  exit 1
fi
echo "Building against PostgreSQL $ver: OK"
```

Set `MIN_PG_VERSION_NUM` for each major branch from the advisory's fixed versions. The script then blocks anyone, including your future self, from shipping an extension built against old headers.

### Restart after rebuild

Libraries in `shared_preload_libraries` load at postmaster start, and backends cache libraries once they've loaded them. After replacing `.so` files, restart again. Plan the maintenance window as patch, rebuild, restart, so you only restart once.

## Step 4: Lock Down CREATE Privileges

Patching fixes this bug. Reducing `CREATE` privileges limits who can exploit the next one. A type confusion bug that went unnoticed for 22 years is a reasonable sign that others exist, so if only a few roles can create objects, fewer accounts can trigger them.

### Audit who can create what

This query lists every non-superuser login-capable role that can create objects in each non-system schema of the current database:

```sql
SELECT r.rolname,
       n.nspname AS schema,
       r.rolcanlogin AS can_login
FROM pg_roles r
CROSS JOIN pg_namespace n
WHERE has_schema_privilege(r.oid, n.oid, 'CREATE')
  AND NOT r.rolsuper
  AND r.rolname NOT LIKE 'pg\_%'
  AND n.nspname NOT LIKE 'pg\_%'
  AND n.nspname <> 'information_schema'
ORDER BY r.rolname, n.nspname;
```

Then check database-level privileges. `CREATE` on a database lets a role create new schemas, and in which it then owns everything. `TEMPORARY` lets it create temp objects:

```sql
SELECT r.rolname,
       d.datname,
       has_database_privilege(r.oid, d.oid, 'CREATE')    AS can_create_schema,
       has_database_privilege(r.oid, d.oid, 'TEMPORARY') AS can_create_temp
FROM pg_roles r
CROSS JOIN pg_database d
WHERE NOT r.rolsuper
  AND r.rolcanlogin
  AND d.datallowconn
ORDER BY 1, 2;
```

Also find roles with cluster-wide creation powers:

```sql
SELECT rolname, rolcreatedb, rolcreaterole, rolcanlogin
FROM pg_roles
WHERE (rolcreatedb OR rolcreaterole)
  AND NOT rolsuper
ORDER BY 1;
```

### The pg_upgrade trap

PostgreSQL 15 changed the default so that `PUBLIC` no longer gets `CREATE` on the `public` schema in **new** clusters. Databases carried forward with `pg_upgrade` keep their old ACLs. If your cluster started on an older major version and was upgraded in place, check directly:

```sql
SELECT nspname, nspacl FROM pg_namespace WHERE nspname = 'public';
```

If the ACL contains an entry like `=UC/...` (empty grantee means `PUBLIC`, and `C` is `CREATE`), every login role can create objects in `public`. Fix it:

```sql
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
```

### Tighten database-level grants

`PUBLIC` gets `CONNECT` and `TEMPORARY` on every database by default. Revoke what you don't need and grant explicitly:

```sql
REVOKE CREATE    ON DATABASE appdb FROM PUBLIC;
REVOKE TEMPORARY ON DATABASE appdb FROM PUBLIC;
REVOKE CONNECT   ON DATABASE appdb FROM PUBLIC;

GRANT CONNECT ON DATABASE appdb TO app_rw, app_ro, app_migrator;
GRANT TEMPORARY ON DATABASE appdb TO app_rw;  -- only if the app actually uses temp tables
```

The advisory doesn't say whether temporary objects are enough to trigger CVE-2026-6460, so confirm that there. Either way, taking `TEMPORARY` away from roles that don't use it costs you very little.

Also note: since PostgreSQL 13, a non-superuser with `CREATE` on a database can install extensions marked **trusted**. That's another reason to keep database-level `CREATE` tightly limited.

### Separate migration from runtime

The biggest structural fix is to stop letting your application's runtime role own its schema. Use a pattern like this:

```sql
-- Owner role: owns objects, cannot log in directly
CREATE ROLE app_owner NOLOGIN;

-- Migration role: used only by CI/CD, inherits owner privileges via SET ROLE
CREATE ROLE app_migrator LOGIN PASSWORD '...' IN ROLE app_owner;

-- Runtime role: DML only, no CREATE anywhere
CREATE ROLE app_rw LOGIN PASSWORD '...';

CREATE SCHEMA app AUTHORIZATION app_owner;
REVOKE ALL ON SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO app_rw;

-- Ensure future tables created by the owner are usable by runtime
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA app
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA app
  GRANT USAGE, SELECT ON SEQUENCES TO app_rw;
```

Migrations run as `app_migrator`, which does `SET ROLE app_owner;` first. The running application connects as `app_rw`, so a SQL injection in your web tier no longer reaches a role that can create objects. If your ORM insists on running migrations at boot, move that into a separate job with its own credentials. That one change removes a large class of attack paths.

Restrict where `app_migrator` can connect from in `pg_hba.conf`:

```
# TYPE  DATABASE  USER          ADDRESS          METHOD
hostssl appdb     app_migrator  10.20.30.0/28    scram-sha-256   # CI runners only
hostssl appdb     app_rw        10.20.40.0/24    scram-sha-256   # app tier
```

## Step 5: Limit What a Compromise Can Do

Assume a future bug gets someone code execution as the `postgres` OS user. Here's how to limit what they can do with it.

### Systemd sandboxing

A drop-in unit takes a few minutes to write and blocks a lot of post-exploitation activity:

```ini
# /etc/systemd/system/postgresql@.service.d/hardening.conf
[Service]
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/postgresql /var/run/postgresql /var/log/postgresql
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
```

Adjust `ReadWritePaths` for your layout (RHEL uses `/var/lib/pgsql`), including tablespace and WAL archive locations. Test this on a replica first. `ProtectSystem=strict` will break any path you forgot to list.

### Egress control

A database server rarely needs to make arbitrary outbound connections. If you can, restrict outbound traffic from the `postgres` user with `nftables` owner matching:

```bash
PG_UID=$(id -u postgres)
nft add table inet pgegress
nft add chain inet pgegress out '{ type filter hook output priority 0; policy accept; }'
nft add rule inet pgegress out meta skuid $PG_UID ip daddr { 10.0.0.0/8 } accept
nft add rule inet pgegress out meta skuid $PG_UID ct state established,related accept
nft add rule inet pgegress out meta skuid $PG_UID drop
```

Be careful with this. WAL archiving to object storage, logical replication to external targets, and `postgres_fdw` all make outbound connections. Allow those destinations explicitly before you enable the drop rule.

### Credential hygiene

Review what the `postgres` account can read: `~/.pgpass`, environment files for backup tools, cloud credentials used by `archive_command`. Prefer instance identity or workload identity over static keys in files, so a shell as `postgres` doesn't give the attacker long-lived cloud credentials.

## Step 6: Detect Exploitation Attempts

There are no public details here on indicators of compromise, so hunt by behavior, not by signature.

**Process execution.** Normal PostgreSQL rarely spawns shells. The exceptions are known commands like `archive_command` and `restore_command`. Log every `execve` by the postgres user and baseline it:

```bash
# /etc/audit/rules.d/postgres-exec.rules
-a always,exit -F arch=b64 -S execve -F euid=<postgres-uid> -k pg_exec
```

Anything other than your archive and restore tooling under that key should be investigated.

**DDL logging.** At minimum:

```
log_statement = 'ddl'
log_connections = on
log_disconnections = on
```

Better still, use `pgaudit` with `pgaudit.log = 'ddl, role'` so you get structured records of object creation and privilege changes. Unexpected DDL from a runtime role, especially after you've removed its `CREATE` rights, is a strong signal that something is wrong.

**Catalog diffing.** Take a snapshot of `pg_proc`, `pg_type`, and `pg_operator` contents, excluding the system schemas, before and after the patch window. Compare it against a known-good baseline from your migration history. Objects that no migration created need an explanation.

## The Checklist

For the change ticket:

- [ ] **Inventory:** network sweep, cloud APIs, Kubernetes images; compared against CMDB
- [ ] **External exposure:** no PostgreSQL ports reachable from the internet
- [ ] **Patch:** every server on the fixed minor version from the advisory; `pg_postmaster_start_time()` confirms restart
- [ ] **Extensions:** every C library from `pg_proc.probin` and `*_preload_libraries` rebuilt or upgraded; stale-`.so` scan comes back clean
- [ ] **Headers:** `-dev`/`-devel` packages upgraded; CI build guard in place
- [ ] **Restart:** after extension rebuild
- [ ] **CREATE lockdown:** `public` schema ACL verified; `CREATE`/`TEMPORARY` on databases revoked from `PUBLIC`; runtime roles have no `CREATE` anywhere
- [ ] **Role separation:** migration credentials separate from runtime; `pg_hba.conf` restricts migrator source IPs
- [ ] **Blast radius:** systemd hardening and egress rules tested on a replica, then rolled out
- [ ] **Detection:** `execve` auditing, DDL logging, catalog baseline in place
- [ ] **Open risks:** any extension still waiting on a vendor rebuild is tracked with an owner and a date

## Final Thought

A bug that sat in a heavily scrutinized codebase for 22 years shows that our privilege models have to hold up even when the code underneath them has flaws. Patching and rebuilding close this particular hole. Taking `CREATE` away from roles that don't need it, splitting migrations from runtime, and sandboxing the server process all keep reducing your exposure to bugs that haven't been found yet.

Patch this week. Rebuild your extensions as part of the same work, not as a follow-up. Then fix the privilege model, which is the work that will still be protecting you after the next PostgreSQL advisory.

## Sources

- [PostgreSQL Patches 52 Flaws, Including 22-Year-Old Bug Enabling Authenticated RCE](https://thehackernews.com/2026/11/postgresql-patches-52-flaws-including.html) (2026-11-13)
