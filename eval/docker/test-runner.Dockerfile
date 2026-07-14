FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip \
    nodejs npm \
    golang-go \
    rustc cargo \
    default-jdk \
    cmake g++ make \
    && pip3 install --break-system-packages pytest \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g jest

WORKDIR /workspace

ENTRYPOINT ["/bin/bash", "-c"]
