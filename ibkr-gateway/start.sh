#!/bin/bash

cd /opt/ibkr

echo "=== IBKR Client Portal Gateway ==="
date
java -version 2>&1

export RUNTIME_PATH="root:dist/ibgroup.web.core.iblink.router.clientportal.gw.jar:build/lib/runtime/*"

echo "Attempting HTTP mode (listenSsl: false)..."
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

# Wait for gateway to start or fail
sleep 10

# Check if gateway is alive
if ! kill -0 $GW_PID 2>/dev/null; then
  echo "HTTP mode failed. Trying HTTPS mode with socat bridge..."

  # Restore SSL config
  sed -i 's/listenSsl: false/listenSsl: true/' root/conf.yaml
  echo 'sslCert: "vertx.jks"' >> root/conf.yaml
  echo 'sslPwd: "mywebapi"' >> root/conf.yaml

  # Start gateway on HTTPS port 5001
  sed -i 's/listenPort: 5000/listenPort: 5001/' root/conf.yaml

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

  sleep 5

  if kill -0 $GW_PID 2>/dev/null; then
    echo "HTTPS mode started on 5001. Starting socat bridge 5000(HTTP) -> 5001(HTTPS)..."
    apk add --no-cache socat 2>/dev/null
    socat TCP-LISTEN:5000,fork,reuseaddr OPENSSL:127.0.0.1:5001,verify=0 &
    echo "Bridge active. HTTP:5000 -> HTTPS:5001"
  else
    echo "Both modes failed. Keeping container alive for debugging."
    sleep 86400
    exit 1
  fi
fi

echo "Gateway running (PID $GW_PID). Waiting..."
wait $GW_PID
echo "Gateway exited. Keeping alive..."
sleep 86400
