#!/bin/bash
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

echo ""
echo -e "${BOLD}  ┌─────────────────────────────────┐${RESET}"
echo -e "${BOLD}  │       ${CYAN}OpenHinge Installer${RESET}${BOLD}        │${RESET}"
echo -e "${BOLD}  │  ${DIM}Self-hosted AI Gateway${RESET}${BOLD}          │${RESET}"
echo -e "${BOLD}  └─────────────────────────────────┘${RESET}"
echo ""

# Install directory
INSTALL_DIR="${OPENHINGE_DIR:-$HOME/openhinge}"

# Detect OS and package manager
OS="$(uname -s)"
install_pkg() {
  local pkg="$1"
  echo -e "${CYAN}→${RESET} Installing ${pkg}..."
  if [ "$OS" = "Darwin" ]; then
    if command -v brew &>/dev/null; then
      brew install "$pkg"
    else
      echo -e "${YELLOW}!${RESET} Homebrew not found. Installing Homebrew first..."
      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
      brew install "$pkg"
    fi
  elif command -v apt-get &>/dev/null; then
    sudo apt-get update -qq && sudo apt-get install -y -qq "$pkg"
  elif command -v dnf &>/dev/null; then
    sudo dnf install -y -q "$pkg"
  elif command -v yum &>/dev/null; then
    sudo yum install -y -q "$pkg"
  elif command -v pacman &>/dev/null; then
    sudo pacman -S --noconfirm "$pkg"
  else
    echo -e "${RED}✗${RESET} Could not auto-install ${pkg}. Please install it manually."
    exit 1
  fi
}

# ── Check git ──────────────────────────────────────────────────
if ! command -v git &>/dev/null; then
  if [ "$OS" = "Darwin" ]; then
    echo -e "${YELLOW}!${RESET} git not found — installing via Xcode Command Line Tools..."
    xcode-select --install 2>/dev/null || true
    echo ""
    echo -e "  ${YELLOW}If a dialog appeared, click Install and re-run this script after.${RESET}"
    echo ""
    exit 1
  else
    install_pkg git
  fi
fi
echo -e "${GREEN}✓${RESET} git $(git --version | awk '{print $3}')"

# ── Check Node.js ──────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  if [ "$OS" = "Darwin" ]; then
    install_pkg node
  else
    # Install Node.js 20 via NodeSource
    echo -e "${CYAN}→${RESET} Installing Node.js 20..."
    if command -v apt-get &>/dev/null; then
      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
      sudo apt-get install -y -qq nodejs
    elif command -v dnf &>/dev/null; then
      curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
      sudo dnf install -y -q nodejs
    else
      install_pkg nodejs
    fi
  fi
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ] 2>/dev/null; then
  echo -e "${RED}✗${RESET} Node.js 18+ required (found v$(node -v | sed 's/v//'))"
  echo ""
  echo "  Upgrade: brew upgrade node / nvm install 20"
  echo ""
  exit 1
fi
echo -e "${GREEN}✓${RESET} Node.js $(node -v)"

# ── Check npm ──────────────────────────────────────────────────
if ! command -v npm &>/dev/null; then
  echo -e "${RED}✗${RESET} npm not found (should come with Node.js)"
  echo "  Try reinstalling Node.js"
  exit 1
fi
echo -e "${GREEN}✓${RESET} npm $(npm -v)"

echo ""

# ── Clone or update ───────────────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
  echo -e "${CYAN}→${RESET} Updating existing installation at ${BOLD}$INSTALL_DIR${RESET}"
  cd "$INSTALL_DIR"
  git checkout -- package-lock.json 2>/dev/null || true
  git pull --ff-only origin main
else
  echo -e "${CYAN}→${RESET} Installing to ${BOLD}$INSTALL_DIR${RESET}"
  git clone https://github.com/openhinge/openhinge.git "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# ── Install dependencies ─────────────────────────────────────
echo -e "${CYAN}→${RESET} Installing dependencies..."
npm install --production=false --silent 2>&1 | tail -1

# ── Build ─────────────────────────────────────────────────────
echo -e "${CYAN}→${RESET} Building..."
npm run build 2>&1 | tail -1

# ── Link globally ────────────────────────────────────────────
echo -e "${CYAN}→${RESET} Linking openhinge command..."
npm link --silent 2>/dev/null || {
  # npm link may need sudo on some systems
  echo -e "${YELLOW}!${RESET} Trying with sudo..."
  sudo npm link --silent 2>/dev/null || echo -e "${YELLOW}!${RESET} Could not link globally. Use: cd ~/openhinge && npx openhinge"
}
if command -v openhinge &>/dev/null; then
  echo -e "${GREEN}✓${RESET} openhinge command available globally"
else
  echo -e "${YELLOW}!${RESET} Run 'cd ~/openhinge && npx openhinge' if the command is not found"
fi

echo ""
echo -e "${GREEN}✓${RESET} OpenHinge installed successfully"
echo ""

# ── Kill existing instance if running ─────────────────────────
EXISTING_PID=$(lsof -ti:3700 2>/dev/null || true)
if [ -n "$EXISTING_PID" ]; then
  echo -e "${YELLOW}!${RESET} Port 3700 in use — stopping existing instance (PID $EXISTING_PID)"
  kill $EXISTING_PID 2>/dev/null || true
  sleep 1
fi

# ── Start the server and open browser ─────────────────────────
echo -e "${CYAN}→${RESET} Starting OpenHinge..."
echo ""

# Open browser after a short delay (background)
(sleep 3 && open "http://localhost:3700" 2>/dev/null || xdg-open "http://localhost:3700" 2>/dev/null) &

npm start
