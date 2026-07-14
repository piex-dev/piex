FROM oven/bun:1.3.14-slim

RUN bun install -g @oh-my-pi/pi-coding-agent@16.4.8

WORKDIR /workspace

ENTRYPOINT ["omp"]
