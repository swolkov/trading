FROM eclipse-temurin:17-jre-alpine

RUN apk add --no-cache curl unzip bash nginx

WORKDIR /opt/ibkr

# Download IBKR Client Portal Gateway
RUN curl -L --fail -o clientportal.gw.zip \
      "https://download2.interactivebrokers.com/portal/clientportal.gw.zip" && \
    unzip -o clientportal.gw.zip && \
    rm clientportal.gw.zip

# Config + nginx + startup
COPY conf.yaml /opt/ibkr/root/conf.yaml
COPY nginx.conf /etc/nginx/http.d/default.conf
COPY start.sh /opt/ibkr/start.sh
RUN chmod +x /opt/ibkr/start.sh && mkdir -p /run/nginx

EXPOSE 5000

CMD ["/opt/ibkr/start.sh"]
