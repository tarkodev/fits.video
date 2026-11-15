# syntax=docker/dockerfile:1.7

# --- Stage 1: build the SvelteKit static site ---------------------------------
FROM node:22-alpine@sha256:2c752226d477b4a886378baa95b9af252be59301b725fdb0b7e15208131505a8 AS builder

WORKDIR /app

ARG PUBLIC_API_URL
ARG WEB_HOST
ARG WEB_PORT
ARG DEV_ALLOWED_HOSTS
ENV PUBLIC_API_URL=$PUBLIC_API_URL \
    WEB_HOST=$WEB_HOST \
    WEB_PORT=$WEB_PORT \
    DEV_ALLOWED_HOSTS=$DEV_ALLOWED_HOSTS

# Install dependencies first so this layer stays cached as long as
# package.json / package-lock.json don't change.
COPY package.json package-lock.json .npmrc ./
RUN npm ci

# Copy the rest of the sources and produce the static build under /app/build.
COPY . .
RUN npm run check && npm run build

# --- Stage 2: serve the build with nginx --------------------------------------
FROM nginx:alpine@sha256:0530961ff0592b58c10f767535cc0abdfccf9e389ff7cc90f87320c1bc7e8506

COPY --from=builder /app/build /usr/share/nginx/html
COPY nginx.conf /etc/nginx/nginx.conf

EXPOSE 80
