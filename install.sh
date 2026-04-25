#!/usr/bin/env bash
set -euo pipefail

REPO="mellofordev/santhosh"
BUN_BIN="$HOME/.bun/bin"
INSTALL_ROOT="$HOME/.santhosh"
SOURCE_DIR="$INSTALL_ROOT/source"

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

# ── 2. install santhosh source ────────────────────────────────────────────────
header "Installing santhosh..."

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$INSTALL_ROOT" "$BUN_BIN"

curl -fsSL "https://github.com/${REPO}/archive/refs/heads/master.tar.gz" -o "$TMP_DIR/santhosh.tar.gz"
tar -xzf "$TMP_DIR/santhosh.tar.gz" -C "$TMP_DIR"
rm -rf "$SOURCE_DIR"
mv "$TMP_DIR/santhosh-master" "$SOURCE_DIR"

(
  cd "$SOURCE_DIR"
  bun install
)

if [ ! -f "$SOURCE_DIR/packages/cli/src/index.ts" ]; then
  warning "Downloaded source is missing packages/cli/src/index.ts. Aborting."
  exit 1
fi

cat > "$BUN_BIN/santhosh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "$SOURCE_DIR"
BUN_EXE="\$(command -v bun || true)"
if [ -z "\$BUN_EXE" ]; then
  BUN_EXE="$BUN_BIN/bun"
fi
exec "\$BUN_EXE" run packages/cli/src/index.ts "\$@"
EOF
chmod +x "$BUN_BIN/santhosh"
info "santhosh installed at $BUN_BIN/santhosh"

# Remove a stale Bun global package symlink if one points at the broken
# github package layout. The wrapper above is now the source of truth.
rm -rf "$HOME/.bun/install/global/node_modules/santhosh" 2>/dev/null || true

# ── 3. add bun bin to PATH in the user's shell rc ────────────────────────────
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

# ── 4. done ───────────────────────────────────────────────────────────────────
header "Done!"
echo ""
echo -e "  Your shell config is set up. To use ${bold}santhosh${reset} ${bold}right now${reset} in this terminal,"
echo -e "  run one of these (choose what fits your shell):"
echo ""
echo -e "    ${bold}exec \$SHELL${reset}                              ${yellow}# reload your shell${reset}"
echo -e "    ${bold}source ${PATCHED_FILES[0]:-~/.zshrc}${reset}"
echo -e "    ${bold}export PATH=\"$BUN_BIN:\$PATH\"${reset}"
echo ""
echo -e "  Then: ${bold}santhosh${reset}"
echo ""
echo -e "  ${green}New terminals will have santhosh on PATH automatically.${reset}"
echo ""

# ── 5. self-test ──────────────────────────────────────────────────────────────
echo -e "  ${bold}Quick self-test:${reset}"
if PATH="$BUN_BIN:$PATH" command -v santhosh >/dev/null 2>&1; then
  PATH="$BUN_BIN:$PATH" santhosh --help 2>&1 | head -1 | sed "s/^/    /"
  info "self-test passed"
else
  warning "santhosh still not on PATH within this script — check $BUN_BIN/santhosh manually"
fi
echo ""
