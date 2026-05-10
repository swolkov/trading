#!/bin/bash
set -e

cd /opt/ibkr

echo "=== IBKR Client Portal Gateway ==="
echo "Port: 5000 (HTTPS)"
echo "==================================="

# Verify the gateway files exist
if [ ! -f "dist/ibgroup.web.core.iblink.router.clientportal.gw.jar" ]; then
  echo "ERROR: Gateway jar not found!"
  ls -la dist/ 2>/dev/null || echo "dist/ directory missing"
  ls -la /opt/ibkr/
  sleep 3600
  exit 1
fi

if [ ! -f "root/conf.yaml" ]; then
  echo "ERROR: conf.yaml not found!"
  ls -la root/ 2>/dev/null
  sleep 3600
  exit 1
fi

if [ ! -f "root/vertx.jks" ]; then
  echo "ERROR: SSL keystore (vertx.jks) not found!"
  ls -la root/ 2>/dev/null
  sleep 3600
  exit 1
fi

echo "Gateway JAR: dist/ibgroup.web.core.iblink.router.clientportal.gw.jar"
echo "Config: root/conf.yaml"
echo "SSL Keystore: root/vertx.jks"
echo ""
echo "Starting gateway..."
echo "Visit https://<your-domain> to authenticate with IBKR"
echo ""

# Run using the same classpath as IBKR's official run.sh
export RUNTIME_PATH="root:dist/ibgroup.web.core.iblink.router.clientportal.gw.jar:build/lib/runtime/*"

exec java \
  -server \
  -Dvertx.disableDnsResolver=true \
  -Djava.net.preferIPv4Stack=true \
  -Dvertx.logger-delegate-factory-class-name=io.vertx.core.logging.SLF4JLogDelegateFactory \
  -cp "${RUNTIME_PATH}" \
  ibgroup.web.core.clientportal.gw.GatewayStart \
  --conf root/conf.yaml
