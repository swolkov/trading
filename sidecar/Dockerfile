FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --requirement requirements.txt
COPY databento-md-sidecar.py .
CMD ["python", "-u", "databento-md-sidecar.py"]
