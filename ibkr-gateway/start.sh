#!/bin/bash

cd /opt/ibkr

echo "=== IBKR Client Portal Gateway ==="
java -version 2>&1

# Gateway runs HTTPS on 5001, nginx proxies HTTP 5000 -> HTTPS 5001
sed -i 's/listenPort: 5000/listenPort: 5001/' root/conf.yaml

echo "Starting IBKR gateway on HTTPS:5001..."
export RUNTIME_PATH="root:dist/ibgroup.web.core.iblink.router.clientportal.gw.jar:build/lib/runtime/*"

java \
  -server \
  -Xmx512m \
  -Dvertx.disableDnsResolver=true \
  -Djava.net.preferIPv4Stack=true \
  -Dvertx.logger-delegate-factory-class-name=io.vertx.core.logging.SLF4JLogDelegateFactory \
  -cp "${RUNTIME_PATH}" \
  ibgroup.web.core.clientportal.gw.GatewayStart \
  --conf root/conf.yaml 2>&1 &
GW_PID=$!

echo "Waiting for gateway startup..."
sleep 12

if kill -0 $GW_PID 2>/dev/null; then
  echo "Gateway running. Starting nginx proxy HTTP:5000 -> HTTPS:5001..."
  nginx
  echo "Ready. Visit https://your-domain to login."
  wait $GW_PID
else
  echo "Gateway failed to start."
  sleep 86400
fi
