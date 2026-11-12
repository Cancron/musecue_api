#!/usr/bin/env bash
set -euo pipefail

echo "Setting up PostgreSQL 17 and Redis..."

# Support root environments without sudo
if [ "$(id -u)" -eq 0 ]; then
    SUDO=()
elif command -v sudo >/dev/null 2>&1; then
    SUDO=(sudo)
else
    echo "Run this script as root or install sudo."
    exit 1
fi

export DEBIAN_FRONTEND=noninteractive

# Install dependencies
"${SUDO[@]}" apt-get update
"${SUDO[@]}" apt-get install -y \
    curl ca-certificates gnupg lsb-release

# Add PostgreSQL official repository if needed
if ! apt-cache show postgresql-17 >/dev/null 2>&1; then
    "${SUDO[@]}" install -d \
        /usr/share/postgresql-common/pgdg

    curl -fsSL \
        https://www.postgresql.org/media/keys/ACCC4CF8.asc \
        | "${SUDO[@]}" gpg --dearmor --yes \
        -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg

    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
        | "${SUDO[@]}" tee \
        /etc/apt/sources.list.d/pgdg.list >/dev/null

    "${SUDO[@]}" apt-get update
fi

# Install PostgreSQL and Redis
"${SUDO[@]}" apt-get install -y \
    postgresql-17 redis-server

# Start PostgreSQL without systemd
"${SUDO[@]}" pg_ctlcluster 17 main start || {
    "${SUDO[@]}" pg_ctlcluster 17 main status
}

# Start Redis without systemd
if ! redis-cli ping 2>/dev/null | grep -q PONG; then
    "${SUDO[@]}" redis-server --daemonize yes
fi

# Verify services
"${SUDO[@]}" pg_isready
redis-cli ping

echo "PostgreSQL 17 and Redis are ready!"
