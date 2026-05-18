FROM oven/bun:1.3-slim
WORKDIR /app

# Install gbrain from GitHub (pulls latest tagged release)
RUN bun install -g github:garrytan/gbrain

# Force single-pool mode (skip dual-pool direct URL which needs IPv6/IPv4 add-on on Supabase)
ENV GBRAIN_DISABLE_DIRECT_POOL=1

# Default port; Render overrides via $PORT
ENV PORT=3131

# Health check via gbrain's /health endpoint
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget --quiet --tries=1 --spider http://localhost:${PORT}/health || exit 1

EXPOSE 3131
CMD ["sh", "-c", "gbrain serve --http --port ${PORT}"]
