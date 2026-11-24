FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        nodejs \
        npm \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt

# Local data and configuration are excluded from the build context.
ENV IEEG_AGENT_CONFIG_DIR=/app/config
RUN useradd --create-home --uid 1001 appuser \
    && install -d -o appuser -g appuser /app/data /app/logs /app/config
COPY --chown=appuser:appuser config.example.yaml /app/config/config.yaml
COPY --chown=appuser:appuser user_config.example.yaml /app/config/user_config.yaml
COPY --chown=appuser:appuser . /app
USER appuser

EXPOSE 8001

CMD ["uvicorn", "runtime.main:app", "--host", "0.0.0.0", "--port", "8001"]
