#!/bin/bash

# Start IBKR Client Portal Gateway
cd /opt/ibkr/root

echo "Starting IBKR Client Portal Gateway..."
echo "Paper Trading Mode: ON"
echo "Port: 5000"

# Start the gateway
java -server -Dvertx.disableDnsResolver=true \
  -Djava.net.preferIPv4Stack=true \
  -jar bin/run.jar root/conf.yaml
