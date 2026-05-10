#!/bin/bash
set -e

cd /opt/ibkr

echo "=== IBKR Client Portal Gateway ==="
echo "Paper Trading Mode: ON"
echo "Port: 5000"

# Find the run.jar
RUNJAR=$(find /opt/ibkr -name "run.jar" -type f | head -1)

if [ -z "$RUNJAR" ]; then
  echo "ERROR: run.jar not found!"
  find /opt/ibkr -name "*.jar" -type f
  exit 1
fi

echo "Found: $RUNJAR"

# Find or create conf file
CONFDIR=$(dirname "$RUNJAR")/..
CONF="$CONFDIR/root/conf.yaml"

if [ ! -f "$CONF" ]; then
  CONF="/opt/ibkr/root/conf.yaml"
fi

echo "Config: $CONF"
echo "Starting gateway..."

java -server \
  -Dvertx.disableDnsResolver=true \
  -Djava.net.preferIPv4Stack=true \
  -jar "$RUNJAR" "$CONF"
