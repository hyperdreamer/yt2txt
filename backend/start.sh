#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# Install deps if missing
if ! python3 -c "import fastapi" 2>/dev/null; then
    echo "Installing dependencies..."
    python3 -m pip install -q -r requirements.txt
fi

# Copy config if not present
if [ ! -f config.yaml ]; then
    echo "No config.yaml found — copying from config.example.yaml"
    cp config.example.yaml config.yaml
    echo "Edit config.yaml to set your API key, then re-run."
    exit 1
fi

echo "Starting YT2TXT backend..."
exec python3 main.py
