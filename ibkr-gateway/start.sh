#!/bin/bash
set -e

cd /opt/ibkr

echo "=== IBKR Client Portal Gateway ==="
echo "Gateway: HTTPS on port 5000"
echo "Nginx proxy: HTTP on port 8080"
echo "==================================="

# Verify files
if [ ! -f "dist/ibgroup.web.core.iblink.router.clientportal.gw.jar" ]; then
  echo "ERROR: Gateway jar not found!"
  ls -la /opt/ibkr/
  sleep 3600
  exit 1
fi

echo "Starting nginx reverse proxy..."
nginx

echo "Starting IBKR gateway..."
export RUNTIME_PATH="root:dist/ibgroup.web.core.iblink.router.clientportal.gw.jar:build/lib/runtime/*"

exec java \
  -server \
  -Dvertx.disableDnsResolver=true \
  -Djava.net.preferIPv4Stack=true \
  -Dvertx.logger-delegate-factory-class-name=io.vertx.core.logging.SLF4JLogDelegateFactory \
  -cp "${RUNTIME_PATH}" \
  ibgroup.web.core.clientportal.gw.GatewayStart \
  --conf root/conf.yaml
