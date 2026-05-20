---
title: "Unlocking PostgreSQL Performance: A Deep Dive with eBPF and EXPLAIN ANALYZE"
date: 2026-05-20
category: "thought-leadership"
tags: []
excerpt: "Optimizing database query performance is a perennial challenge for any engineer working with data-intensive applications. Slow queries can cripple app..."
---

# Unlocking PostgreSQL Performance: A Deep Dive with eBPF and EXPLAIN ANALYZE

Optimizing database query performance is a perennial challenge for any engineer working with data-intensive applications. Slow queries can cripple application responsiveness, exhaust server resources, and ultimately lead to a poor user experience. While PostgreSQL's `EXPLAIN ANALYZE` is an invaluable tool for understanding query execution plans, sometimes you need to go deeper—peering into the kernel to understand the true bottlenecks. This is where eBPF shines, offering unprecedented visibility into system calls, I/O, and CPU utilization directly related to your database workload.

In this post, we'll explore how to combine the power of `EXPLAIN ANALYZE` with eBPF to diagnose and resolve complex PostgreSQL performance issues. We'll move beyond just looking at the query plan and dive into the underlying system behavior.

## The Foundation: Understanding `EXPLAIN ANALYZE`

Before we introduce eBPF, let's briefly recap `EXPLAIN ANALYZE`. This command executes a query and then returns the actual execution plan, including runtime statistics like total time, row counts, and I/O costs for each step.

Consider a simple, but potentially slow, query on a `users` table without a proper index on `last_login_at`:

```sql
SELECT id, email, last_login_at
FROM users
WHERE last_login_at < NOW() - INTERVAL '1 year'
ORDER BY last_login_at DESC
LIMIT 100;
```

Running `EXPLAIN ANALYZE` on this query might yield output similar to this (simplified for brevity):

```
QUERY PLAN
------------------------------------------------------------------------------------------------------
 Limit  (cost=1000.00..1000.00 rows=100 width=76) (actual time=150.000..155.000 rows=100 loops=1)
   ->  Sort  (cost=1000.00..1000.00 rows=10000 width=76) (actual time=150.000..154.000 rows=100 loops=1)
         Sort Key: last_login_at DESC
         Sort Method: Top-N heapsort  Memory: 85kB
         ->  Seq Scan on users  (cost=0.00..900.00 rows=10000 width=76) (actual time=0.010..120.000 rows=10000 loops=1)
               Filter: (last_login_at < (now() - '1 year'::interval))
               Rows Removed by Filter: 990000
 Planning Time: 0.100 ms
 Execution Time: 155.100 ms
```

From this, we can immediately identify a `Seq Scan` (sequential scan) on the `users` table and a `Sort` operation. The `Seq Scan` means PostgreSQL had to read the entire table to find matching rows, and the `Sort` indicates that the database had to sort a large number of rows in memory (or on disk if it exceeded `work_mem`). This is a classic case for an index.

**Actionable Takeaway:** Always start with `EXPLAIN ANALYZE`. Look for `Seq Scan` on large tables, large `Sort` operations, and high `actual time` discrepancies compared to `cost`.

## Introducing eBPF for Deeper Insight

While `EXPLAIN ANALYZE` tells us *what* PostgreSQL is doing, it doesn't always tell us *why* it's taking so long from a system perspective. Is it CPU-bound? Waiting on disk I/O? Contending for locks? eBPF (extended Berkeley Packet Filter) allows us to dynamically load programs into the Linux kernel to observe system events without modifying kernel source code or rebooting.

For our PostgreSQL example, we can use eBPF tools from the `bcc` (BPF Compiler Collection) toolkit to monitor I/O, CPU usage, and system calls specific to the `postgres` processes.

### Scenario: High I/O During Sequential Scans

Let's assume our `EXPLAIN ANALYZE` shows a `Seq Scan` taking a long time, and we suspect it's due to high disk I/O. We can use `biosnoop` (or `ext4slower`, `xfslower` for specific filesystems) to monitor block device I/O:

```bash
sudo biosnoop -p $(pgrep -d',' -f '^postgres: ')
```

This command will show I/O operations, including the process ID (PID), block device, and latency, for all PostgreSQL processes. If we see a large number of read operations with high latencies during our query execution, it confirms our suspicion of I/O being the bottleneck.

```
# Example biosnoop output during a slow Seq Scan
TIME(s)        COMM             PID    DISK    T  BYTES  LAT(ms)
0.000000000    postgres         12345  sda     R  4096   0.5
0.000100000    postgres         12345  sda     R  4096   0.6
...
1.000000000    postgres         12345  sda     R  4096   1.2
```

### Scenario: Unexpected CPU Usage or Context Switching

Perhaps the `EXPLAIN ANALYZE` shows a costly `Sort` operation, and we're wondering if it's consuming excessive CPU or leading to context switching. We can use `profile` to sample CPU stacks or `syscount` to monitor system calls.

To profile CPU usage for PostgreSQL processes:

```bash
sudo profile -p $(pgrep -d',' -f '^postgres: ') -F 99 -f -a -d 5
```

This will sample stack traces at 99Hz for 5 seconds, showing which functions are consuming CPU time within the PostgreSQL processes. If we see a significant portion of CPU time spent in sorting algorithms or other unexpected functions, it can guide further investigation.

For system call monitoring, `syscount` can be useful:

```bash
sudo syscount -p $(pgrep -d',' -f '^postgres: ')
```

This will show the count of system calls made by PostgreSQL processes. A sudden spike in `read()` or `write()` calls during a query, especially if not expected, can indicate inefficient data access patterns.

## Combining the Insights: A Practical Example

Let's return to our original slow query:

```sql
SELECT id, email, last_login_at
FROM users
WHERE last_login_at < NOW() - INTERVAL '1 year'
ORDER BY last_login_at DESC
LIMIT 100;
```

1.  **Start with `EXPLAIN ANALYZE`:**
    As we saw, it revealed a `Seq Scan` and a `Sort`. The `Seq Scan` suggests missing an index for the `WHERE` clause, and the `Sort` suggests an index could help with `ORDER BY`.

2.  **Hypothesis:** The `Seq Scan` is causing excessive I/O, and the `Sort` is consuming CPU/memory.

3.  **Validate with eBPF:**
    *   Run `biosnoop` in one terminal.
    *   Execute the slow query in another.
    *   Observe `biosnoop` output. If you see high `LAT(ms)` and many `R` (read) operations from PostgreSQL processes, it confirms I/O as a major factor for the `Seq Scan`.
    *   Run `profile` (or `perf record`) during the query. Look for CPU hot spots. If sorting functions appear prominently, it confirms CPU usage for the `Sort` operation.

4.  **Implement Solution:**
    Based on the combined evidence, the solution is clear: create an index on `last_login_at`.

    ```sql
    CREATE INDEX idx_users_last_login_at ON users (last_login_at DESC);
    ```
    We specify `DESC` in the index definition because our `ORDER BY` clause uses `DESC`. This allows PostgreSQL to perform an index-only scan or at least avoid an explicit sort.

5.  **Verify with `EXPLAIN ANALYZE` (again) and eBPF:**
    Run `EXPLAIN ANALYZE` on the query again:

    ```
    QUERY PLAN
    ------------------------------------------------------------------------------------------------------
     Limit  (cost=0.43..4.45 rows=100 width=76) (actual time=0.030..0.080 rows=100 loops=1)
       ->  Index Scan Backward using idx_users_last_login_at on users  (cost=0.43..4.45 rows=100 width=76) (actual time=0.025..0.070 rows=100 loops=1)
             Filter: (last_login_at < (now() - '1 year'::interval))
             Rows Removed by Filter: 0
     Planning Time: 0.150 ms
     Execution Time: 0.090 ms
    ```

    Notice the dramatic reduction in `cost` and `actual time`. We now have an `Index Scan Backward` which is much more efficient. The `Filter` is applied during the index scan, and `Rows Removed by Filter` is 0, indicating the index efficiently narrowed down the results.

    Now, run `biosnoop` and `profile` during the optimized query. You should see significantly less I/O and CPU usage attributed to the `postgres` processes for this specific query.

**Actionable Takeaway:** Use eBPF to validate your `EXPLAIN ANALYZE` hypotheses. If `EXPLAIN ANALYZE` points to I/O, confirm it with `biosnoop`. If it points to CPU, confirm with `profile`. This holistic view ensures you're addressing the root cause.

## Beyond the Basics: Advanced eBPF for PostgreSQL

The examples above are just the tip of the iceberg. More advanced eBPF techniques can provide even deeper insights:

*   **`funccount`**: Count calls to specific PostgreSQL internal functions.
*   **`stackcount`**: Sample kernel and user stack traces for specific events.
*   **Custom eBPF programs**: For highly specific scenarios, you can write your own eBPF programs to trace PostgreSQL's internal locking mechanisms, buffer manager interactions, or other low-level events. This requires a deeper understanding of PostgreSQL internals and eBPF programming.

## Conclusion

Optimizing PostgreSQL performance is an art and a science. While `EXPLAIN ANALYZE` remains your primary lens into query execution, augmenting it with eBPF provides unparalleled visibility into the kernel's perspective. By combining these powerful tools, you can move beyond educated guesses, pinpoint the true bottlenecks—whether they are I/O, CPU, memory, or contention—and implement targeted, effective solutions. Embrace both `EXPLAIN ANALYZE` and eBPF to truly master your PostgreSQL