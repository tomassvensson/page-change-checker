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
FROM mcr.microsoft.com/playwright:v1.51.0-jammy AS runtime

WORKDIR /app

# Install only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev && npx playwright install --with-deps chromium

# Copy compiled output from the build stage
COPY --from=build /app/dist ./dist

# Persistent data lives in a mounted volume at /app/data
VOLUME ["/app/data"]

ENV NODE_ENV=production

ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["schedule"]
