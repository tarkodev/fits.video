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

# Configure the API endpoint
cp .env.example .env
# Edit .env to point to your 8mb.local backend

# Start development server
npm run dev
```

The app will be available at `http://localhost:5173`

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PUBLIC_API_URL` | URL of the 8mb.local backend | `https://video.elhacker.net` |

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

```bash
docker-compose up -d
```

This will serve the built static files via nginx on port 80.

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
