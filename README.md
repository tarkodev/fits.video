# fits.video

> MP4, GIF, whatever: now it fits.

A modern, free video compression web app. Compress your videos to a specific file size in your browser.

![SvelteKit](https://img.shields.io/badge/SvelteKit-5-FF3E00?logo=svelte)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript)
![License](https://img.shields.io/badge/License-MIT-green)

## ✨ Features

- **🎯 Target Size Compression** - Compress videos to your desired file size (8MB, 10MB, 25MB, etc.)
- **📱 PWA Support** - Install as a native app on any device
- **🎬 Live Preview** - Preview your video before compression
- **📤 Drag & Drop** - Simply drag your video into the browser
- **⚡ Real-time Progress** - Track upload and compression progress with SSE
- **🌙 Dark Mode** - Beautiful dark-themed glassmorphism UI

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- A running [8mb.local](https://github.com/JMS1717/8mb.local) backend

### Installation

```bash
# Clone the repository
git clone https://github.com/tarkodev/fits.video.git
cd fits.video

# Install dependencies
npm install

# Configure environment (required, no defaults baked into the code)
cp .env.example .env
# Edit .env to point to your 8mb.local backend and tweak the bind/port

# Start development server
npm run dev
```

With the stock `.env`, the app listens on `http://localhost:8002`.

### Environment Variables

All variables in `.env.example` are required. The dev server and
`vite build` will refuse to start if any of them is missing.

Backend client (inlined into the bundle at build time):

| Variable | Description | Example |
|----------|-------------|---------|
| `PUBLIC_API_URL` | URL of the 8mb.local backend | `https://dev-local.fits.video` |
| `PUBLIC_API_AUTH_USER` | Basic auth username used by the stock backend | `admin` |
| `PUBLIC_API_AUTH_PASS` | Basic auth password used by the stock backend | `changeme` |

Web server bind (consumed by `npm run dev` **and** the `docker compose`
host port mapping):

| Variable | Description | Example |
|----------|-------------|---------|
| `WEB_HOST` | Bind address for the dev server | `0.0.0.0` |
| `WEB_PORT` | Port `vite dev` listens on, and the host-side port for the docker container | `8002` |

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

A multi-stage `Dockerfile` is provided so `docker compose up` is the only
command you need (no manual `npm run build` first):

```bash
# Builds the image once, then runs it on the host port set by WEB_PORT in .env.
docker compose up -d --build
```

The first run takes ~1 minute (npm ci + Vite build). Subsequent
`docker compose up -d` calls reuse the cached image and start instantly.
Use `docker compose up -d --build` whenever you change the source code; the
Docker layer cache will skip `npm ci` as long as `package*.json` haven't
moved.

If you want to point the build at a different backend, drop a `.env` next
to the `Dockerfile` (it's gitignored) before building — SvelteKit inlines
the `PUBLIC_*` values at build time:

```bash
cp .env.example .env
# edit .env
docker compose up -d --build
```

The `.env` is read inside the builder stage only and never lands in the
final nginx image (only `/app/build` is copied across).

## 🔧 Backend

This is a frontend-only project. It requires the [8mb.local](https://github.com/JMS1717/8mb.local) backend for video processing.

The backend handles:
- Video upload and storage
- FFmpeg-based compression
- Real-time progress streaming via SSE
- File download serving

## 📁 Project Structure

```
fits.video/
├── src/
│   ├── app.css           # Global styles
│   ├── app.html          # HTML template
│   ├── lib/
│   │   └── api.ts        # API client
│   └── routes/
│       └── +page.svelte  # Main page
├── static/
│   ├── manifest.json     # PWA manifest
│   └── icons/            # App icons
├── Dockerfile            # Multi-stage image (builder + nginx)
├── docker-compose.yml    # Docker setup
└── nginx.conf            # Nginx config
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
