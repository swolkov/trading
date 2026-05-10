#!/bin/bash

cd /opt/ibkr

echo "=== IBKR Gateway Debug ==="
date
echo "Java version:"
java -version 2>&1
echo ""

echo "Checking files..."
ls -la dist/*.jar 2>/dev/null && echo "JAR: OK" || echo "JAR: MISSING"
ls -la root/conf.yaml 2>/dev/null && echo "CONF: OK" || echo "CONF: MISSING"
ls -la root/vertx.jks 2>/dev/null && echo "JKS: OK" || echo "JKS: MISSING"
echo ""

# Start a simple HTTP responder on port 5000 for Railway healthcheck
# while the gateway starts in the background
echo "Starting temp health responder..."
while true; do echo -e "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"starting\":true}" | nc -l -p 5000 -q 1 2>/dev/null || true; done &
HEALTH_PID=$!
sleep 2

echo "Launching IBKR gateway..."
export RUNTIME_PATH="root:dist/ibgroup.web.core.iblink.router.clientportal.gw.jar:build/lib/runtime/*"

# Kill the temp responder — gateway will take over port 5000
kill $HEALTH_PID 2>/dev/null
sleep 1

java \
  -server \
  -Xmx512m \
  -Dvertx.disableDnsResolver=true \
  -Djava.net.preferIPv4Stack=true \
  -Dvertx.logger-delegate-factory-class-name=io.vertx.core.logging.SLF4JLogDelegateFactory \
  -cp "${RUNTIME_PATH}" \
  ibgroup.web.core.clientportal.gw.GatewayStart \
  --conf root/conf.yaml 2>&1

EXIT_CODE=$?
echo ""
echo "=== Gateway exited with code $EXIT_CODE ==="
echo "Container staying alive for log inspection..."
# Keep alive so Railway doesn't restart and we can read logs
sleep 86400
