#!/bin/bash
set -e

cd /opt/ibkr

echo "=== IBKR Client Portal Gateway ==="
echo "Paper Trading Mode: ON"
echo "Port: 5000 (HTTP)"
echo "==================================="

# Find the run.jar
RUNJAR=$(find /opt/ibkr -name "run.jar" -type f | head -1)

if [ -z "$RUNJAR" ]; then
  echo "ERROR: run.jar not found! Listing all jars:"
  find /opt/ibkr -name "*.jar" -type f
  echo ""
  echo "Listing directory structure:"
  ls -la /opt/ibkr/
  ls -la /opt/ibkr/*/ 2>/dev/null || true
  # Keep container alive so we can debug via Railway logs
  echo "Sleeping to keep container alive for debugging..."
  sleep 3600
  exit 1
fi

echo "Found JAR: $RUNJAR"
GWDIR=$(dirname "$RUNJAR")/..

# Use our conf.yaml
CONF="/opt/ibkr/root/conf.yaml"
if [ ! -f "$CONF" ]; then
  # Try to find any conf.yaml
  CONF=$(find /opt/ibkr -name "conf.yaml" -type f | head -1)
fi

if [ -z "$CONF" ] || [ ! -f "$CONF" ]; then
  echo "ERROR: conf.yaml not found!"
  find /opt/ibkr -name "*.yaml" -type f
  sleep 3600
  exit 1
fi

echo "Config: $CONF"
echo "Starting gateway..."

# Run the gateway — it will listen on port 5000
# The gateway requires browser login — it will start and wait for auth
exec java -server \
  -Dvertx.disableDnsResolver=true \
  -Djava.net.preferIPv4Stack=true \
  -jar "$RUNJAR" "$CONF"
