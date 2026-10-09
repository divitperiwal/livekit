FROM ghcr.io/astral-sh/uv:0.12.13-python3.13-trixie-slim

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PATH=/app/.venv/bin:$PATH

RUN useradd --create-home --uid 1000 worker
WORKDIR /app

# Dependencies first: they change less often than the source, so this layer stays cached.
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --frozen --no-dev --no-install-project
COPY src ./src
RUN uv sync --frozen --no-dev

# Model weights (VAD, turn detector) go into the image, into the runtime user's cache,
# so no call waits for a download and a cold start never depends on Hugging Face.
USER worker
RUN agent download-files

CMD ["agent", "start"]
