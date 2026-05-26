FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir databento psycopg2-binary
COPY databento-md-sidecar.py .
CMD ["python", "-u", "databento-md-sidecar.py"]
