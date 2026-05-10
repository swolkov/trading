FROM eclipse-temurin:17-jre-alpine

RUN apk add --no-cache curl unzip bash nginx

WORKDIR /opt/ibkr

# Download and extract IBKR Client Portal Gateway
RUN curl -L --fail -o clientportal.gw.zip \
      "https://download2.interactivebrokers.com/portal/clientportal.gw.zip" && \
    unzip -o clientportal.gw.zip && \
    rm clientportal.gw.zip && \
    chmod +x bin/run.sh

# Override conf.yaml — allow all IPs
COPY conf.yaml /opt/ibkr/root/conf.yaml

# Nginx config — accepts HTTP on port 8080, proxies to gateway HTTPS on 5000
RUN mkdir -p /run/nginx
COPY nginx.conf /etc/nginx/http.d/default.conf

# Startup script
COPY start.sh /opt/ibkr/start.sh
RUN chmod +x /opt/ibkr/start.sh

# Railway connects to 8080 (HTTP) -> nginx -> gateway 5000 (HTTPS)
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=10s --start-period=45s --retries=5 \
  CMD curl -sf http://localhost:8080/v1/api/iserver/auth/status || exit 1

CMD ["/opt/ibkr/start.sh"]
