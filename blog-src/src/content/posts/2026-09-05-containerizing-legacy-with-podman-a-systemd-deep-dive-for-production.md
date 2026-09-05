---
title: "Containerizing Legacy with Podman: A Systemd Deep Dive for Production"
date: 2026-09-05
category: "thought-leadership"
tags: ["podman", "systemd", "containerization", "legacy-apps", "linux"]
# series: ""      # optional: set the same value on every part of a multi-part series
# seriesOrder: 1   # this post's position within that series
excerpt: "Many organizations still rely on critical \"old-school\" applications — those monolithic, stateful beasts built before the container revolution...."
---

# Containerizing Legacy with Podman: A Systemd Deep Dive for Production

Many organizations still rely on critical "old-school" applications — those monolithic, stateful beasts built before the container revolution. Rewriting them often isn't feasible, but running them on bare metal or traditional VMs introduces friction, inconsistent environments, and complex deployments. This is where Podman, with its daemonless architecture and seamless integration with Linux tooling, offers a powerful path forward. Specifically, the `podman generate systemd` command can be a game-changer for moving these legacy applications into a production-ready containerized setup.

Let's dive deep into how we can leverage this often-underestimated command to achieve robust, maintainable, and highly available deployments for your long-standing applications.

## Why Podman for Legacy Apps?

Before we get to `systemd`, let's briefly touch on why Podman is an excellent choice for this scenario:

1.  **Daemonless:** Unlike Docker, Podman doesn't require a constantly running daemon. This reduces attack surface and resource overhead, especially appealing for applications that might run on resource-constrained systems or require heightened security.
2.  **Rootless Containers:** Podman allows users to run containers without root privileges, significantly enhancing security by isolating the container from the host system's root user.
3.  **OCI Compliant:** It works with standard OCI images and runtimes, meaning your existing Dockerfiles and images are directly compatible.
4.  **Linux Native:** Podman is designed to be a first-class citizen in the Linux ecosystem, playing nicely with tools like `systemd`, `selinux`, and `firewalld`.

## The Challenge: Production Readiness for Stateful Legacy Apps

Containerizing a legacy app isn't just about getting it to run in a container. For production, you need:

*   **Automatic Startup:** The application must start automatically on boot.
*   **Restart on Failure:** If the container crashes, it needs to be restarted reliably.
*   **Resource Management:** Control over CPU, memory, and I/O.
*   **Logging:** Centralized and accessible logs.
*   **Dependencies:** Proper ordering of service startup (e.g., database before application).
*   **Health Checks:** Mechanisms to determine if the application is truly healthy.

While `podman run --restart=always` handles basic restarts, it's not integrated with the host's init system and doesn't offer the full suite of `systemd` features. This is where `podman generate systemd` shines.

## Deep Dive: `podman generate systemd`

This command takes a running Podman container or a Podman pod (a group of containers) and generates a `systemd` unit file for it. This unit file can then be used by `systemd` to manage the container like any other service on the host.

Let's walk through a practical example. Imagine we have an "old-school" Java application that connects to a local PostgreSQL database. We'll containerize both.

### Step 1: Prepare Your Containers

First, ensure your application is containerized. For simplicity, let's use a basic Nginx container as our "legacy app" and a PostgreSQL container.

```bash
# Start a PostgreSQL container
podman run -d --name legacy-db -e POSTGRES_PASSWORD=mysecretpassword postgres:13

# Start our "legacy app" (Nginx in this example, but imagine your Java app)
# We'll expose port 8080 and link to our database
podman run -d --name legacy-app -p 8080:80 --network container:legacy-db nginx
```

Now you have two running containers: `legacy-db` and `legacy-app`. The `legacy-app` is configured to use the network namespace of `legacy-db`, which is a common pattern for tightly coupled applications.

### Step 2: Generate Systemd Unit Files

This is where the magic happens. We'll generate unit files for both our database and application.

**For the Database:**

```bash
podman generate systemd --name legacy-db --files --new > /etc/systemd/system/legacy-db.service
```

Let's break down the options:

*   `--name legacy-db`: Specifies the container to generate the unit file for.
*   `--files`: Tells Podman to output the unit file content to stdout. Without this, it would just create the file in `~/.config/systemd/user/`.
*   `--new`: This is crucial for production. It generates a unit file that *creates* the container if it doesn't exist, rather than just starting an existing one. This makes the service fully self-contained.

The generated `legacy-db.service` file will look something like this (simplified for brevity):

```ini
# /etc/systemd/system/legacy-db.service
[Unit]
Description=Podman container-legacy-db.service
Documentation=man:podman-generate-systemd(1)
Wants=network-online.target
After=network-online.target

[Service]
Environment=PODMAN_SYSTEMD_UNIT=%n
Restart=on-failure
TimeoutStopUSec=70s
ExecStartPre=/bin/rm -f %t/%n.cid
ExecStart=/usr/bin/podman run --cidfile=%t/%n.cid --cgroups=no-conmon --rm --sdnotify=conmon -d --replace --name legacy-db -e POSTGRES_PASSWORD=mysecretpassword postgres:13
ExecStop=/usr/bin/podman stop --ignore --cidfile=%t/%n.cid
ExecStopPost=/usr/bin/podman rm --ignore --cidfile=%t/%n.cid
Type=notify
NotifyAccess=all

[Install]
WantedBy=multi-user.target
```

**Key takeaways from the generated `legacy-db.service`:**

*   `ExecStartPre=/bin/rm -f %t/%n.cid`: Cleans up the container ID file before starting.
*   `ExecStart=/usr/bin/podman run ...`: This is the `podman run` command that will *create* and start the container if it doesn't exist. Notice `--replace` is included, which ensures that if a container with the same name already exists, it's replaced.
*   `ExecStop=/usr/bin/podman stop ...`: Gracefully stops the container.
*   `ExecStopPost=/usr/bin/podman rm ...`: Removes the container after stopping.
*   `Restart=on-failure`: Configures `systemd` to restart the service if it exits with an error. This is a robust way to handle application crashes.
*   `Type=notify`: `systemd` waits for the service to signal that it has started successfully.

**For the Application (with Dependency):**

Now, for our `legacy-app`, we need to ensure it starts *after* the `legacy-db` service is up.

```bash
podman generate systemd --name legacy-app --files --new > /etc/systemd/system/legacy-app.service
```

We'll then edit `/etc/systemd/system/legacy-app.service` to add the dependency:

```ini
# /etc/systemd/system/legacy-app.service
[Unit]
Description=Podman container-legacy-app.service
Documentation=man:podman-generate-systemd(1)
Wants=network-online.target
After=network-online.target
Requires=legacy-db.service  # Add this line
After=legacy-db.service    # Add this line

[Service]
Environment=PODMAN_SYSTEMD_UNIT=%n
Restart=on-failure
TimeoutStopUSec=70s
ExecStartPre=/bin/rm -f %t/%n.cid
ExecStart=/usr/bin/podman run --cidfile=%t/%n.cid --cgroups=no-conmon --rm --sdnotify=conmon -d --replace -p 8080:80 --network container:legacy-db --name legacy-app nginx
ExecStop=/usr/bin/podman stop --ignore --cidfile=%t/%n.cid
ExecStopPost=/usr/bin/podman rm --ignore --cidfile=%t/%n.cid
Type=notify
NotifyAccess=all

[Install]
WantedBy=multi-u/sr/bin/systemctl enable legacy-app.servicelti-user.target
```

By adding `Requires=legacy-db.service` and `After=legacy-db.service`, we tell `systemd` that `legacy-app` depends on `legacy-db` and should only start after it.

### Step 3: Enable and Start Services

Now, we can enable and start our services using standard `systemd` commands. First, reload the `systemd` daemon to pick up the new unit files.

```bash
sudo systemctl daemon-reload

# Stop existing containers if they are still running from Step 1
sudo podman stop legacy-app legacy-db
sudo podman rm legacy-app legacy-db

# Enable and start the database service
sudo systemctl enable legacy-db.service
sudo systemctl start legacy-db.service

# Enable and start the application service
sudo systemctl enable legacy-app.service
sudo systemctl start legacy-app.service
```

Verify their status:

```bash
sudo systemctl status legacy-db.service
sudo systemctl status legacy-app.service
```

You should see both services active and running. Now, on reboot, these containers will start automatically in the correct order. If `legacy-db` crashes, `systemd` will restart it. If `legacy-app` crashes, it too will be restarted.

## Advanced Considerations and Actionable Takeaways

### 1. Rootless `systemd` Services

For enhanced security, you can run these services as non-root users.

**Actionable Takeaway:** Generate the `systemd` unit files as a non-root user (without `--files` or redirecting to `/etc/systemd/system/`) and place them in `~/.config/systemd/user/`. Then enable and start them using `systemctl --user enable legacy-db.service` and `systemctl --user start legacy-db.service`. Remember to enable the `linger` functionality for the user (`loginctl enable-linger <username>`) so the services persist after logout.

### 2. Environment Variables and Secrets

Hardcoding secrets in the `systemd` unit file is a bad practice.

**Actionable Takeaway:**
*   **Systemd EnvironmentFile:** Use `EnvironmentFile=/path/to/my/secrets.env` in the `[Service]` section of your unit file. This file should contain `KEY=VALUE` pairs. Ensure proper permissions (`600`) on this file.
*   **Podman Secrets:** For more robust secret management, leverage Podman's secret capabilities (though this adds complexity).
*   **Host-mounted Volumes:** Mount a volume containing a configuration file with