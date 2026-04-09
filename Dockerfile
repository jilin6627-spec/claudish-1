# Build Claudish for linux/arm64 with pure proxy support
# Use official bun image for arm64
FROM oven/bun:latest

# Set working directory
WORKDIR /app

# Copy source code
COPY . .

# Install dependencies and build
RUN bun install && bun run build

# Expose default port range
EXPOSE 3000-9000
EXPOSE 8080

# Default: start in pure proxy mode (we'll need to pass env vars at runtime)
ENTRYPOINT ["bun", "run", "packages/cli/dist/index.js", "proxy"]
