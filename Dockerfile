# ---------------------------------------------------------------------------
# Stage 1 – Build
# ---------------------------------------------------------------------------
FROM node:22-slim AS build

WORKDIR /app

# Disable Husky git-hook installation (no .git directory in Docker builds).
ENV HUSKY=0

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2 – Runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm AS runtime

WORKDIR /app

# Copy the fully-compiled node_modules from the build stage and prune dev
# dependencies in-place. This avoids recompiling native modules (e.g.
# better-sqlite3) inside a minimal runtime image that has no build tools.
COPY package*.json ./
COPY --from=build /app/node_modules ./node_modules
RUN npm prune --omit=dev

# Install Chromium system dependencies for Debian 12 (bookworm).
# We install these explicitly instead of using `playwright install --with-deps`
# because playwright's debian12 package list includes font packages that are
# unavailable or mis-named in the bookworm APT repository.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    && rm -rf /var/lib/apt/lists/*

# Download the Chromium binary (system deps already installed above).
RUN npx playwright install chromium

# Copy compiled output from the build stage
COPY --from=build /app/dist ./dist

# Persistent data lives in a mounted volume at /app/data
VOLUME ["/app/data"]

ENV NODE_ENV=production

ENTRYPOINT ["node", "dist/src/cli/index.js"]
CMD ["schedule"]
