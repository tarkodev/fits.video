# syntax=docker/dockerfile:1.7

# --- Stage 1: build the SvelteKit static site ---------------------------------
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies first so this layer stays cached as long as
# package.json / package-lock.json don't change.
COPY package.json package-lock.json .npmrc ./
RUN npm ci

# Copy the rest of the sources and produce the static build under /app/build.
COPY . .
RUN npm run build

# --- Stage 2: serve the build with nginx --------------------------------------
FROM nginx:alpine

COPY --from=builder /app/build /usr/share/nginx/html
COPY nginx.conf /etc/nginx/nginx.conf

EXPOSE 80
