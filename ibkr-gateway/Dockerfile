FROM eclipse-temurin:17-jre-alpine

RUN apk add --no-cache curl unzip bash

WORKDIR /opt/ibkr

# Download and extract IBKR Client Portal Gateway
RUN curl -L --fail -o clientportal.gw.zip \
      "https://download2.interactivebrokers.com/portal/clientportal.gw.zip" && \
    unzip -o clientportal.gw.zip && \
    rm clientportal.gw.zip && \
    chmod +x bin/run.sh

# Override conf.yaml — allow all IPs, enable SSL (required by gateway)
COPY conf.yaml /opt/ibkr/root/conf.yaml

# Copy our startup script
COPY start.sh /opt/ibkr/start.sh
RUN chmod +x /opt/ibkr/start.sh

EXPOSE 5000

HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=5 \
  CMD curl -k -sf https://localhost:5000/v1/api/iserver/auth/status || exit 1

CMD ["/opt/ibkr/start.sh"]
