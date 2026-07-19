#!/bin/sh
set -eu

# Gustave curl | sh installer/updater.
#
# Common usage:
#   curl -fsSL https://raw.githubusercontent.com/cwygoda/gustave/main/install.sh | sh
#
# Private repo / non-default SSH key:
#   curl -fsSL <install.sh-url> | \
#     GIT_SSH_COMMAND='ssh -i ~/.ssh/id_ed25519_cwygoda -o IdentitiesOnly=yes -o BatchMode=yes' sh
#
# Environment knobs:
#   GUSTAVE_REPO          git clone URL (default: git@github.com:cwygoda/gustave.git)
#   GUSTAVE_REF           branch/tag/commit to checkout (default: main)
#   GUSTAVE_INSTALL_DIR   checkout dir (default: ~/.local/src/gustave)
#   GUSTAVE_BIN_DIR       user bin dir (default: ~/.local/bin)
#   GUSTAVE_ONLINE_TEST   1 to include online Svelte MCP smoke (default: 0)
#   GUSTAVE_SKIP_TEST     1 to skip self-test (default: 0)
#   GUSTAVE_NO_UPDATE     1 to skip git pull/fetch in an existing checkout (default: 0)
#   GUSTAVE_SKIP_SSH_DETECT 1 to skip probing SSH keys for GitHub write access

info() { printf '%s\n' "==> $*"; }
warn() { printf '%s\n' "WARN: $*" >&2; }
fail() { printf '%s\n' "ERROR: $*" >&2; exit 1; }

need() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

expand_home() {
  case "$1" in
    \~) printf '%s' "$HOME" ;;
    \~/*) printf '%s/%s' "$HOME" "${1#\~/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

shell_quote() {
  # Single-quote a string for inclusion in GIT_SSH_COMMAND.
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\''/g")"
}

github_owner_from_repo() {
  case "$1" in
    git@github.com:*) path=${1#git@github.com:}; printf '%s' "${path%%/*}"; return 0 ;;
    ssh://git@github.com/*) path=${1#ssh://git@github.com/}; printf '%s' "${path%%/*}"; return 0 ;;
    *) return 1 ;;
  esac
}

test_repo_write_access() {
  command_text=$1
  tmp=${TMPDIR:-/tmp}/gustave-write-test-$$
  rm -rf "$tmp"
  mkdir -p "$tmp"
  (
    cd "$tmp"
    git init -q
    git config user.name "Gustave Installer"
    git config user.email "gustave-installer@example.invalid"
    printf 'gustave write access test\n' > README.md
    git add README.md
    git commit -q -m "chore: test repository write access"
    GIT_SSH_COMMAND=$command_text git push --dry-run "$REPO" HEAD:refs/heads/gustave-install-write-test-$$ >/dev/null 2>&1
  )
  status=$?
  rm -rf "$tmp"
  return "$status"
}

try_git_ssh_command() {
  label=$1
  command_text=$2
  if test_repo_write_access "$command_text"; then
    DETECTED_GIT_SSH_COMMAND=$command_text
    info "Using SSH command with GitHub write access ($label)"
    return 0
  fi
  return 1
}

try_key_file() {
  key=$1
  [ -f "$key" ] || return 1
  case "$key" in
    *.pub|*.cert|*.old|*~) return 1 ;;
  esac
  quoted_key=$(shell_quote "$key")
  try_git_ssh_command "$key" "ssh -i $quoted_key -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=5"
}

detect_github_write_ssh() {
  DETECTED_GIT_SSH_COMMAND=
  [ "${GUSTAVE_SKIP_SSH_DETECT:-0}" = "1" ] && return 1
  github_owner_from_repo "$REPO" >/dev/null 2>&1 || return 1

  info "Looking for an SSH key with write access to $REPO"

  if [ -n "${GIT_SSH_COMMAND:-}" ] && try_git_ssh_command "GIT_SSH_COMMAND" "$GIT_SSH_COMMAND"; then
    return 0
  fi

  if try_git_ssh_command "default ssh" "ssh -o BatchMode=yes -o IdentitiesOnly=no -o ConnectTimeout=5"; then
    return 0
  fi

  if [ -f "$HOME/.ssh/config" ]; then
    while IFS= read -r line; do
      # shellcheck disable=SC2086 # intentional ssh_config-style whitespace splitting
      set -- $line
      [ "${1:-}" = "IdentityFile" ] || [ "${1:-}" = "identityfile" ] || continue
      key=$(expand_home "${2:-}")
      try_key_file "$key" && return 0
    done < "$HOME/.ssh/config"
  fi

  for key in "$HOME"/.ssh/id_*; do
    [ -e "$key" ] || continue
    try_key_file "$key" && return 0
  done

  warn "No SSH key with write access to $REPO was detected; continuing with your default Git SSH behavior"
  return 1
}

need git
need node

REPO=${GUSTAVE_REPO:-git@github.com:cwygoda/gustave.git}
REF=${GUSTAVE_REF:-main}
INSTALL_DIR=$(expand_home "${GUSTAVE_INSTALL_DIR:-~/.local/src/gustave}")
BIN_DIR=$(expand_home "${GUSTAVE_BIN_DIR:-~/.local/bin}")
ONLINE_TEST=${GUSTAVE_ONLINE_TEST:-0}
SKIP_TEST=${GUSTAVE_SKIP_TEST:-0}
NO_UPDATE=${GUSTAVE_NO_UPDATE:-0}
DETECTED_GIT_SSH_COMMAND=

detect_github_write_ssh || true
if [ -n "$DETECTED_GIT_SSH_COMMAND" ]; then
  export GIT_SSH_COMMAND="$DETECTED_GIT_SSH_COMMAND"
fi

if command -v pnpm >/dev/null 2>&1; then
  PNPM=pnpm
else
  if command -v corepack >/dev/null 2>&1; then
    info "pnpm not found; enabling pnpm through corepack"
    corepack enable pnpm >/dev/null 2>&1 || corepack enable >/dev/null 2>&1 || fail "corepack could not enable pnpm"
  fi
  command -v pnpm >/dev/null 2>&1 || fail "pnpm is required. Install pnpm or enable corepack, then rerun."
  PNPM=pnpm
fi

mkdir -p "$(dirname "$INSTALL_DIR")" "$BIN_DIR"

if [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating Gustave in $INSTALL_DIR"
  cd "$INSTALL_DIR"
  if [ "$NO_UPDATE" != "1" ]; then
    git remote set-url origin "$REPO" >/dev/null 2>&1 || true
    git fetch --prune origin "$REF"
    git checkout "$REF" >/dev/null 2>&1 || git checkout -B "$REF" "origin/$REF"
    git pull --ff-only origin "$REF"
  fi
else
  if [ -e "$INSTALL_DIR" ]; then
    fail "$INSTALL_DIR exists but is not a git checkout"
  fi
  info "Cloning Gustave from $REPO into $INSTALL_DIR"
  git clone --branch "$REF" "$REPO" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

info "Installing dependencies with pnpm"
"$PNPM" install --ignore-scripts

info "Installing absolute-path launcher into $BIN_DIR"
node ./bin/gustave.mjs install-bin --dir "$BIN_DIR"

if [ -n "$DETECTED_GIT_SSH_COMMAND" ]; then
  owner=$(github_owner_from_repo "$REPO" || printf '%s' cwygoda)
  info "Persisting detected GitHub SSH command for $owner"
  GUSTAVE_GITHUB_SSH_COMMAND=$DETECTED_GIT_SSH_COMMAND "$BIN_DIR/gustave" github-ssh --owner "$owner" || warn "Could not persist detected GitHub SSH command"
fi

if [ "$SKIP_TEST" != "1" ]; then
  if [ "$ONLINE_TEST" = "1" ]; then
    info "Running Gustave self-test with online smoke"
    "$BIN_DIR/gustave" self-test --online
  else
    info "Running Gustave self-test"
    "$BIN_DIR/gustave" self-test
  fi
else
  warn "Skipping Gustave self-test because GUSTAVE_SKIP_TEST=1"
fi

info "Gustave installed/updated successfully"
info "Launcher: $BIN_DIR/gustave"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "Add this to your shell: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
