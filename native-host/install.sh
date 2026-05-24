#!/bin/bash
# Install native messaging host for AI Chat Extension

set -e

HOST_NAME="com.aichat.nativehost"
HOST_SCRIPT="$(cd "$(dirname "$0")" && pwd)/native-host.py"
MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
EXTENSION_ID="jmfjogmpblnmjmgfgjobimlfgjbjnbif"

# Make host script executable
chmod +x "$HOST_SCRIPT"

# Create manifest directory
mkdir -p "$MANIFEST_DIR"

cat > "$MANIFEST_DIR/$HOST_NAME.json" << EOF
{
  "name": "$HOST_NAME",
  "description": "Native host for AI Chat Extension - Lark CLI, slides, file operations, WebSocket proxy",
  "path": "$HOST_SCRIPT",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF

echo "Native messaging host installed:"
echo "  Host: $HOST_NAME"
echo "  Script: $HOST_SCRIPT"
echo "  Manifest: $MANIFEST_DIR/$HOST_NAME.json"
echo "  Extension ID: $EXTENSION_ID"
