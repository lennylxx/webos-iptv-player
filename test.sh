#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

usage() {
  echo "Usage: $0 [--unit|--e2e|--all]"
  echo ""
  echo "  --unit   Run Vitest unit tests (default)"
  echo "  --e2e    Run Playwright end-to-end tests"
  echo "  --all    Run both unit and e2e tests"
  exit 0
}

MODE="unit"
case "${1:-}" in
  ""|--unit) MODE="unit" ;;
  --e2e)     MODE="e2e" ;;
  --all)     MODE="all" ;;
  -h|--help) usage ;;
  *) error "Unknown option: $1 (use --help)" ;;
esac

# Check dependencies
command -v node >/dev/null 2>&1 || error "Node.js is required. Install with: brew install node"

# Install npm deps if needed
if [ ! -d node_modules ]; then
  info "Installing dependencies..."
  npm install
fi

# webOS 4 / Chromium 53 compatibility gate (CSS features + JS APIs)
info "Linting (webOS 4 / Chromium 53 compat gate)..."
npm run lint

if [ "$MODE" = "unit" ] || [ "$MODE" = "all" ]; then
  info "Running unit tests (Vitest)..."
  npm run test
fi

if [ "$MODE" = "e2e" ] || [ "$MODE" = "all" ]; then
  info "Running end-to-end tests (Playwright)..."
  npm run test:e2e
fi

info "All tests passed."
