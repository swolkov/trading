FROM eclipse-temurin:17-jre-alpine

RUN apk add --no-cache curl unzip bash

WORKDIR /opt/ibkr

# Download IBKR Client Portal Gateway
# The zip extracts to a 'clientportal.gw' subdirectory
RUN curl -L --fail -o clientportal.gw.zip \
      "https://download2.interactivebrokers.com/portal/clientportal.gw.zip" && \
    unzip -o clientportal.gw.zip && \
    rm clientportal.gw.zip && \
    ls -la /opt/ibkr/ && \
    # Find the actual directory name (may vary)
    GWDIR=$(find /opt/ibkr -maxdepth 1 -type d -name "clientportal*" | head -1) && \
    if [ -n "$GWDIR" ] && [ "$GWDIR" != "/opt/ibkr" ]; then \
      mv "$GWDIR"/* /opt/ibkr/ 2>/dev/null || true; \
      mv "$GWDIR"/.* /opt/ibkr/ 2>/dev/null || true; \
      rmdir "$GWDIR" 2>/dev/null || true; \
    fi && \
    ls -la /opt/ibkr/

# Copy config and startup script
COPY conf.yaml /opt/ibkr/root/conf.yaml
COPY start.sh /opt/ibkr/start.sh
RUN chmod +x /opt/ibkr/start.sh

EXPOSE 5000

HEALTHCHECK --interval=60s --timeout=10s --start-period=30s \
  CMD curl -k -f https://localhost:5000/v1/api/iserver/auth/status || exit 1

CMD ["/opt/ibkr/start.sh"]
