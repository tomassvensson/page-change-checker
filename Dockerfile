# ---------------------------------------------------------------------------
# Stage 1 – Build
# ---------------------------------------------------------------------------
FROM node:22-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2 – Runtime (Playwright + Chromium)
# ---------------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.60.0-jammy AS runtime

WORKDIR /app

# Install only production dependencies.
# The base image already ships Chromium for Playwright v1.60.0, so there is no
# need to run `playwright install` – the npm package will use the pre-installed
# browser at /ms-playwright automatically.
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled output from the build stage
COPY --from=build /app/dist ./dist

# Persistent data lives in a mounted volume at /app/data
VOLUME ["/app/data"]

ENV NODE_ENV=production

ENTRYPOINT ["node", "dist/src/cli/index.js"]
CMD ["schedule"]
