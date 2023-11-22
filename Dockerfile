FROM node:14-slim
ARG VERSION

COPY . /app
RUN npm install -g /app
#brainlife@$VERSION

RUN apt-get update && apt-get install -y --no-install-recommends jq && rm -rf /var/lib/apt/lists/*

ENTRYPOINT ["bl"]
