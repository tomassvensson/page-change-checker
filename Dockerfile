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

# Download Chromium and its system dependencies for Playwright.
# node:22-bookworm (full, not slim) is required – playwright's --with-deps
# relies on system libraries absent from the slim variant.
RUN npx playwright install --with-deps chromium && rm -rf /var/lib/apt/lists/*

# Copy compiled output from the build stage
COPY --from=build /app/dist ./dist

# Persistent data lives in a mounted volume at /app/data
VOLUME ["/app/data"]

ENV NODE_ENV=production

ENTRYPOINT ["node", "dist/src/cli/index.js"]
CMD ["schedule"]
