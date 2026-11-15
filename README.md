# fits.video

> MP4, GIF, whatever: now it fits.

A modern, free video compression web app. Compress your videos to a specific file size in your browser.

![SvelteKit](https://img.shields.io/badge/SvelteKit-5-FF3E00?logo=svelte)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript)
![License](https://img.shields.io/badge/License-MIT-green)

## ✨ Features

- **🎯 Target Size Compression** - Compress videos to your desired file size (8MB, 10MB, 20MB, etc.)
- **📱 PWA Support** - Install as a native app on any device
- **🎬 Live Preview** - Preview your video before compression
- **📤 Drag & Drop** - Simply drag your video into the browser
- **⚡ Real-time Progress** - Track upload and compression progress with SSE
- **🌙 Dark Mode** - Beautiful dark-themed glassmorphism UI

## 🚀 Quick Start

### Prerequisites

- Node.js 20.19+ (required by `@sveltejs/vite-plugin-svelte`)
- A running [8mb.local](https://github.com/JMS1717/8mb.local) backend

### Installation

```bash
# Clone the repository
git clone https://github.com/tarkodev/fits.video.git
cd fits.video

# Install dependencies
npm ci

# Configure environment (required, no defaults baked into the code)
cp .env.example .env
# Set a free frontend port. Configure the private backend in .gateway.env.

# Start development server
npm run dev
```

The example uses port 8080. The deployed dev environment keeps its existing port 8004. Do not start Vite on a port already used by Docker. `npm run dev` serves the frontend only; use the Compose stack for the same-origin gateway and HTTPS cookie flow.

### Environment Variables

All variables in `.env.example` are required. The dev server and
`vite build` will refuse to start if any of them is missing.

Public gateway base (inlined into the static frontend at build time):

| Variable | Description | Example |
|----------|-------------|---------|
| `PUBLIC_API_URL` | Base of the gateway; `/` calls `/api/*` on the same origin | `/` |

The browser uses an anonymous, secure session cookie. Backend credentials must
never be configured in `PUBLIC_*` variables. Older `PUBLIC_API_AUTH_*` values
must be removed from the frontend environment when switching to this gateway.
Store any required upstream Basic credentials only in the gateway environment.

Web server bind (consumed by `npm run dev` **and** the `docker compose`
host port mapping):

| Variable | Description | Example |
|----------|-------------|---------|
| `WEB_HOST` | Bind address for the dev server | `0.0.0.0` |
| `WEB_PORT` | Port `vite dev` listens on, and the host-side port for the docker container | `8080` |

Vite dev server:

| Variable | Description | Example |
|----------|-------------|---------|
| `DEV_ALLOWED_HOSTS` | Comma-separated extra hostnames (loopback always works), or `*` to allow any | `*` (open) / `dev.fits.video` (restricted) |

## 🛠️ Tech Stack

- **[SvelteKit 2](https://kit.svelte.dev/)** - Full-stack web framework
- **[Svelte 5](https://svelte.dev/)** - Frontend with runes reactivity
- **[TypeScript](https://www.typescriptlang.org/)** - Type safety
- **[Vite](https://vitejs.dev/)** - Build tool

## 📦 Building for Production

```bash
# Build static site
npm run build

# Preview production build
npm run preview
```

The output will be in the `build/` directory, ready to be served by any static file server.

### Docker Deployment

The repository contains two independent services: the static Nginx frontend and
the TypeScript gateway in `gateway/`. 8mb.local remains a separate deployment.
See [gateway configuration and security](gateway/README.md) for the complete
route allowlist, ownership rules, persistence and limits.

```bash
cp .env.example .env
cp gateway/.env.example .gateway.env
# Configure GATEWAY_PUBLIC_ORIGIN and the private GATEWAY_UPSTREAM_URL.
# Set FITS_BACKEND_NETWORK in .env to the private 8mb.local Docker network.
docker compose config --quiet
docker compose up -d --build web gateway
docker compose ps
```

Only the gateway joins the configured backend network. For multiple stacks on
the same host, set a distinct FITS_GATEWAY_SUBNET, FITS_GATEWAY_PROXY_IP and
FITS_GATEWAY_SERVICE_IP per stack.
The gateway has no published host port. Its SQLite state is stored in the
`gateway_state` named volume and must be backed up with the deployment.

Nginx relays `/api/*` without buffering uploads, downloads or SSE. Other paths
serve the existing static build. Deploy behind HTTPS: the anonymous cookie is
`Secure`, `HttpOnly`, `SameSite=Strict` and scoped to the public frontend host.
The direct 8mb.local admin hostname must be protected independently with Exoti
login, and direct backend ports must be filtered against bypasses.

The frontend Docker build receives only explicit public build arguments. Private
`.env` / `.gateway.env` files and gateway source/state are excluded from that
build context. All upstream access and optional credentials stay server-side.

## 🔧 Backend

The frontend stays static. Its gateway requires the separate
[8mb.local](https://github.com/JMS1717/8mb.local) backend for video processing.

The backend handles:
- Video upload and storage
- FFmpeg-based compression
- Real-time progress streaming via SSE
- File download serving

## 📁 Project Structure

```
fits.video/
├── src/
│   ├── app.css                       # Global styles
│   ├── app.html                      # HTML template
│   ├── lib/
│   │   ├── api.ts                    # HTTP / SSE client for the public gateway
│   │   ├── compression.svelte.ts     # Upload → compress → download state machine
│   │   ├── format.ts                 # Pure formatting & validation helpers
│   │   └── components/
│   │       ├── EmptyDropZone.svelte  # Empty drop-zone with URL input
│   │       ├── FilePreview.svelte    # Selected file preview + controls
│   │       ├── ProgressDisplay.svelte # Upload / compression progress UI
│   │       └── SizeSelector.svelte   # Target-size preset + custom input
│   └── routes/
│       ├── +layout.svelte            # Root layout
│       ├── +layout.ts                # Disables SSR (static adapter)
│       └── +page.svelte              # Main page (file selection + orchestration)
├── static/
│   ├── manifest.json                 # PWA manifest
│   └── icons/                        # App icons
├── gateway/                          # Private TypeScript gateway and ownership state
├── Dockerfile                        # Multi-stage image (builder + nginx)
├── docker-compose.yml                # Docker setup
├── nginx.conf                        # Nginx config (static + security headers)
└── vite.config.ts                    # Dev server, env-driven host/port
```

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the project
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [8mb.local](https://github.com/JMS1717/8mb.local) - The backend that powers the video compression
- [SvelteKit](https://kit.svelte.dev/) - For the amazing developer experience
