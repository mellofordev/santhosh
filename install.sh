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

# ── 4. add bun bin to PATH in the user's shell rc ────────────────────────────
PATCHED_FILES=()

add_to_path() {
  local file="$1"
  local line="$2"
  if [ -f "$file" ] && grep -qF "$BUN_BIN" "$file"; then
    info "PATH already set in $file"
    PATCHED_FILES+=("$file")
    return
  fi
  mkdir -p "$(dirname "$file")"
  echo -e "$line" >> "$file"
  info "Added PATH to $file"
  PATCHED_FILES+=("$file")
}

SHELL_NAME="$(basename "${SHELL:-bash}")"
case "$SHELL_NAME" in
  zsh)
    add_to_path "$HOME/.zshrc" "\nexport PATH=\"$BUN_BIN:\$PATH\""
    ;;
  bash)
    add_to_path "$HOME/.bashrc"      "\nexport PATH=\"$BUN_BIN:\$PATH\""
    add_to_path "$HOME/.bash_profile" "\nexport PATH=\"$BUN_BIN:\$PATH\""
    ;;
  fish)
    add_to_path "$HOME/.config/fish/config.fish" "\nfish_add_path \"$BUN_BIN\""
    ;;
  *)
    warning "Unknown shell '${SHELL_NAME}'. Patching ~/.profile as a fallback."
    add_to_path "$HOME/.profile" "\nexport PATH=\"$BUN_BIN:\$PATH\""
    ;;
esac

# ── 5. done ───────────────────────────────────────────────────────────────────
header "Done!"
echo ""
echo -e "  Your shell config is set up. To use ${bold}santhosh${reset} ${bold}right now${reset} in this terminal,"
echo -e "  run one of these (choose what fits your shell):"
echo ""
echo -e "    ${bold}exec \$SHELL${reset}                              ${yellow}# reload your shell${reset}"
echo -e "    ${bold}source ${PATCHED_FILES[0]:-~/.zshrc}${reset}"
echo -e "    ${bold}export PATH=\"$BUN_BIN:\$PATH\"${reset}"
echo ""
echo -e "  Then: ${bold}santhosh init${reset} → ${bold}santhosh start${reset}"
echo ""
echo -e "  ${green}New terminals will have santhosh on PATH automatically.${reset}"
echo ""
