#!/bin/bash

cd /opt/ibkr

echo "=== IBKR Client Portal Gateway ==="
java -version 2>&1

# Patch the port to 5001 so socat can bridge on 5000
sed -i 's/listenPort: 5000/listenPort: 5001/' root/conf.yaml

echo "Starting gateway via IBKR's own run.sh..."
bash bin/run.sh root/conf.yaml 2>&1 &
GW_PID=$!

echo "Waiting 15s for gateway startup..."
sleep 15

if kill -0 $GW_PID 2>/dev/null; then
  echo "Gateway is running! Starting socat bridge HTTP:5000 -> HTTPS:5001"
  socat TCP-LISTEN:5000,fork,reuseaddr OPENSSL:127.0.0.1:5001,verify=0 &
  echo "Bridge active. Ready on port 5000."
  wait $GW_PID
else
  echo "Gateway failed. Keeping alive for logs..."
  sleep 86400
fi
