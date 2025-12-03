#!/bin/bash
# Initializer Script for PARA Visualizer
# Verifies runtime prerequisites and core artifacts for the plugin.

set -e

cd "$(dirname "$0")"

echo "🔧 Bootstrapping PARA Visualizer..."

if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js not found in PATH."
  exit 1
fi

# Optional: install/build if a package manifest is added later
if [ -f "package.json" ]; then
  if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
  else
    echo "✅ Dependencies already installed."
  fi

  echo "🔨 Building plugin..."
  npm run build
else
  echo "ℹ️ No package.json present; skipping npm install/build."
fi

if [ -f "main.js" ] && [ -f "manifest.json" ]; then
  echo "✅ Core artifacts present (main.js + manifest.json)."
  exit 0
else
  echo "❌ Missing main.js or manifest.json."
  exit 1
fi
