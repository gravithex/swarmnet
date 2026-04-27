FROM golang:1.25 AS builder
RUN apt-get update && apt-get install -y git make ca-certificates
RUN git clone https://github.com/gensyn-ai/axl.git /axl
WORKDIR /axl
RUN go build -o node ./cmd/node/

FROM ubuntu:22.04
# wget is required by docker-compose healthchecks.
RUN apt-get update && apt-get install -y ca-certificates wget && rm -rf /var/lib/apt/lists/*
COPY --from=builder /axl/node /usr/local/bin/axl-node
WORKDIR /app
# /app/keys is the mount point for per-agent private key files.
RUN mkdir -p /app/keys
EXPOSE 9002
ENTRYPOINT ["axl-node", "-config", "/app/axl-config.json"]
