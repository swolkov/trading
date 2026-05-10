#!/bin/bash

cd /opt/ibkr

echo "=== IBKR Client Portal Gateway ==="
echo "Starting on port 5000 (HTTPS)"
date

# Verify
if [ ! -f "dist/ibgroup.web.core.iblink.router.clientportal.gw.jar" ]; then
  echo "FATAL: Gateway jar missing"
  ls -laR /opt/ibkr/ 2>&1 | head -50
  sleep 86400
  exit 1
fi

echo "JAR found. Launching..."

export RUNTIME_PATH="root:dist/ibgroup.web.core.iblink.router.clientportal.gw.jar:build/lib/runtime/*"

java \
  -server \
  -Xmx512m \
  -Dvertx.disableDnsResolver=true \
  -Djava.net.preferIPv4Stack=true \
  -Dvertx.logger-delegate-factory-class-name=io.vertx.core.logging.SLF4JLogDelegateFactory \
  -cp "${RUNTIME_PATH}" \
  ibgroup.web.core.clientportal.gw.GatewayStart \
  --conf root/conf.yaml 2>&1

# If Java exits, keep container alive so we can read logs
echo "Gateway exited with code $?"
echo "Keeping container alive for debugging..."
sleep 86400
