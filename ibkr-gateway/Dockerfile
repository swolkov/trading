FROM eclipse-temurin:17-jre-alpine

# Install curl for health checks
RUN apk add --no-cache curl unzip bash

# Download IBKR Client Portal Gateway
WORKDIR /opt/ibkr
RUN curl -L -o clientportal.gw.zip "https://download2.interactivebrokers.com/portal/clientportal.gw.zip" && \
    unzip clientportal.gw.zip && \
    rm clientportal.gw.zip

# Copy config
COPY conf.yaml /opt/ibkr/root/conf.yaml
COPY start.sh /opt/ibkr/start.sh
RUN chmod +x /opt/ibkr/start.sh

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s CMD curl -k -f https://localhost:5000/v1/api/iserver/auth/status || exit 1

CMD ["/opt/ibkr/start.sh"]
