#!/bin/bash

cd /opt/ibkr

echo "=== IBKR Client Portal Gateway ==="
java -version 2>&1

# Use IBKR's exact original config but on port 5001
sed -i 's/listenPort: 5000/listenPort: 5001/' root/conf.yaml

echo "Config:"
cat root/conf.yaml
echo ""

export RUNTIME_PATH="root:dist/ibgroup.web.core.iblink.router.clientportal.gw.jar:build/lib/runtime/*"

echo "Starting gateway on HTTPS port 5001..."
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

echo "Waiting for gateway to start..."
sleep 15

if kill -0 $GW_PID 2>/dev/null; then
  echo "Gateway is running! Starting socat bridge HTTP:5000 -> HTTPS:5001"
  socat TCP-LISTEN:5000,fork,reuseaddr OPENSSL:127.0.0.1:5001,verify=0 &
  echo "Bridge active. Ready for connections on port 5000."
  wait $GW_PID
else
  echo "Gateway failed to start."
  echo "Keeping alive for debugging..."
  sleep 86400
fi
