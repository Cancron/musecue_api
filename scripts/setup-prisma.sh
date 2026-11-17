#!/usr/bin/env bash
# setup-prisma.sh
# Prepares the local Prisma schema engine ONLY. It does not run npm ci and
# does not run prisma generate.
#
# What it does:
#   1. Unzips prisma/prisma-engines/schema-engine.gz
#   2. Makes the result executable and checks that it is a real Linux binary
#   3. Writes PRISMA_SCHEMA_ENGINE_BINARY into .env
#   4. Exports the variables into your current shell (only when sourced)
#
# Usage (recommended: "source", so the variables stay in your terminal and
# the next "npm ci" / "npx prisma generate" can see them):
#   source scripts/setup-prisma.sh
#   npm ci
#   npx prisma generate
#
# Running it with "bash scripts/setup-prisma.sh" also works, but a child
# process cannot export variables to your terminal, so you must export them
# yourself afterwards (the script prints the exact commands).

# Detect whether the file is being sourced or executed.
_prisma_sourced=0
(return 0 2>/dev/null) && _prisma_sourced=1

setup_prisma_engine() {
  local platform="debian-openssl-3.0.x"
  local script_dir project_root engine_dir gz_file engine_file env_file

  # --- Locate project root (folder containing package.json) -----------------
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ -f "$script_dir/package.json" ]; then
    project_root="$script_dir"
  elif [ -f "$script_dir/../package.json" ]; then
    project_root="$(cd "$script_dir/.." && pwd)"
  else
    echo "ERROR: package.json not found next to or above this script." >&2
    return 1
  fi

  engine_dir="$project_root/prisma/prisma-engines"
  gz_file="$engine_dir/schema-engine.gz"
  engine_file="$engine_dir/schema-engine-$platform"
  env_file="$project_root/.env"

  # --- 1. Unzip the engine (the .gz is kept) ---------------------------------
  if [ ! -f "$engine_file" ]; then
    if [ ! -f "$gz_file" ]; then
      echo "ERROR: neither $engine_file nor $gz_file exists." >&2
      return 1
    fi
    echo "==> Unzipping $gz_file"
    gunzip -c "$gz_file" > "$engine_file" || { rm -f "$engine_file"; echo "ERROR: gunzip failed." >&2; return 1; }
  else
    echo "==> Engine already unzipped: $engine_file"
  fi

  chmod +x "$engine_file"

  # --- 2. Sanity check: must be a real executable, not an HTML error page ---
  if command -v file >/dev/null 2>&1; then
    if ! file "$engine_file" | grep -q "ELF"; then
      echo "ERROR: $engine_file is not an ELF executable:" >&2
      file "$engine_file" >&2
      echo "The .gz may be a bad download. Delete it and download it again." >&2
      rm -f "$engine_file"
      return 1
    fi
  fi
  "$engine_file" --version 2>/dev/null || echo "(could not print engine version; continuing)"

  # --- 3. Persist the variables in .env ---------------------------------------
  # Note: npm ignores .env. Prisma commands read it through "dotenv/config" in
  # prisma.config.ts. For "npm ci" the variables must be exported in the shell.
  touch "$env_file"
  _prisma_set_env() {
    local key="$1" value="$2"
    if grep -q "^${key}=" "$env_file"; then
      sed -i "s|^${key}=.*|${key}=${value}|" "$env_file"
    else
      echo "${key}=${value}" >> "$env_file"
    fi
  }
  _prisma_set_env PRISMA_SCHEMA_ENGINE_BINARY "$engine_file"
  _prisma_set_env PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING 1
  unset -f _prisma_set_env
  echo "==> Updated $env_file"

  # --- 4. Export for the current shell (effective only when sourced) --------
  export PRISMA_SCHEMA_ENGINE_BINARY="$engine_file"
  export PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1

  echo
  echo "Prisma schema engine is ready: $engine_file"
  if [ "$_prisma_sourced" -eq 1 ]; then
    echo "Variables are exported in this terminal. Next:"
    echo "  npm ci"
    echo "  npx prisma generate"
  else
    echo "This script was run as a child process, so your terminal does NOT have the variables yet."
    echo "Run these two lines in this terminal before 'npm ci':"
    echo "  export PRISMA_SCHEMA_ENGINE_BINARY=\"$engine_file\""
    echo "  export PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1"
  fi
  return 0
}

setup_prisma_engine
_prisma_status=$?
unset -f setup_prisma_engine

if [ "$_prisma_sourced" -eq 1 ]; then
  unset _prisma_sourced
  return "$_prisma_status"
else
  exit "$_prisma_status"
fi