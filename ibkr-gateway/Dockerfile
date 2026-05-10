FROM eclipse-temurin:17-jre-alpine

RUN apk add --no-cache curl unzip bash

WORKDIR /opt/ibkr

# Download IBKR Client Portal Gateway
RUN curl -L --fail -o clientportal.gw.zip \
      "https://download2.interactivebrokers.com/portal/clientportal.gw.zip" && \
    unzip -o clientportal.gw.zip && \
    rm clientportal.gw.zip

# Override config: HTTP mode, allow all IPs
COPY conf.yaml /opt/ibkr/root/conf.yaml

COPY start.sh /opt/ibkr/start.sh
RUN chmod +x /opt/ibkr/start.sh

EXPOSE 5000

# No healthcheck — let Railway handle it, don't kill slow Java startup
CMD ["/opt/ibkr/start.sh"]
