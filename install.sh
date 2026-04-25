#!/usr/bin/env bash
set -euo pipefail

REPO="mellofordev/santhosh"
BUN_BIN="$HOME/.bun/bin"

# ── colours ──────────────────────────────────────────────────────────────────
bold='\033[1m'
green='\033[0;32m'
yellow='\033[0;33m'
reset='\033[0m'

info()    { echo -e "  ${green}✓${reset} $*"; }
warning() { echo -e "  ${yellow}!${reset} $*"; }
header()  { echo -e "\n${bold}$*${reset}"; }

# ── 1. ensure bun is installed ────────────────────────────────────────────────
header "Checking for Bun..."
if ! command -v bun &>/dev/null; then
  info "Bun not found — installing..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$BUN_BIN:$PATH"
else
  info "Bun $(bun --version) found"
fi

# ── 2. clean up any prior install (avoids duplicate-key warnings) ────────────
GLOBAL_PKG="$HOME/.bun/install/global/package.json"
if [ -f "$GLOBAL_PKG" ] && grep -q '"santhosh"' "$GLOBAL_PKG"; then
  bun -e "
    const fs = require('node:fs');
    const p = '$GLOBAL_PKG';
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (j.dependencies) delete j.dependencies.santhosh;
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
  " 2>/dev/null || true
fi

# ── 3. install santhosh ───────────────────────────────────────────────────────
header "Installing santhosh..."
bun add -g "github:${REPO}"
info "santhosh installed"

# ── 3. add bun bin to PATH in the user's shell rc ────────────────────────────
add_to_path() {
  local file="$1"
  local line="$2"
  if [ -f "$file" ] && grep -qF "$BUN_BIN" "$file"; then
    return  # already patched
  fi
  echo -e "$line" >> "$file"
  info "Added PATH to $file"
}

SHELL_NAME="$(basename "${SHELL:-}")"
case "$SHELL_NAME" in
  zsh)
    add_to_path "$HOME/.zshrc" "\nexport PATH=\"$BUN_BIN:\$PATH\""
    ;;
  bash)
    # write to both — which one loads depends on terminal type
    add_to_path "$HOME/.bashrc"  "\nexport PATH=\"$BUN_BIN:\$PATH\""
    add_to_path "$HOME/.bash_profile" "\nexport PATH=\"$BUN_BIN:\$PATH\""
    ;;
  fish)
    add_to_path "$HOME/.config/fish/config.fish" "\nfish_add_path \"$BUN_BIN\""
    ;;
  *)
    warning "Unknown shell '${SHELL_NAME}'. Add this manually to your shell config:"
    echo ""
    echo "    export PATH=\"$BUN_BIN:\$PATH\""
    echo ""
    ;;
esac

# ── 4. make it available in the current session ───────────────────────────────
export PATH="$BUN_BIN:$PATH"

# ── 5. done ───────────────────────────────────────────────────────────────────
header "Done!"
echo ""
echo -e "  Run ${bold}santhosh init${reset} to set up your node, then ${bold}santhosh start${reset}"
echo ""

# Verify it works right now
if command -v santhosh &>/dev/null; then
  info "santhosh is ready in this shell"
else
  warning "Open a new terminal (or run: export PATH=\"$BUN_BIN:\$PATH\") to use santhosh"
fi
