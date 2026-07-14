FROM node:22-slim

RUN npm install -g @earendil-works/pi-coding-agent@0.80.6

WORKDIR /workspace

ENTRYPOINT ["pi"]
