FROM python:3.12-slim

WORKDIR /app

# System deps: ca-certificates for HTTPS to Steam/GOG/Epic/ITAD
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

# Python deps
COPY backend/requirements.txt requirements-dev.txt ./
RUN pip install --no-cache-dir -r api/requirements.txt -r requirements-dev.txt

# App
COPY server.py ./ 
COPY backend/ ./backend/
COPY public/ ./public/

ENV PORT=8080
ENV HOST=0.0.0.0
EXPOSE 8080

# Health probe follows $PORT: the image defaults to 8080, but Render injects
# 10000, so a hardcoded port would probe a socket nothing is listening on.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD python3 -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/api/health' % os.environ.get('PORT','8080'), timeout=3)" || exit 1

CMD ["python", "server.py"]