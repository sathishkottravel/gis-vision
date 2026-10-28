import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The page calls the API under `/api`, so the browser sees one origin and the API needs no
// CORS. Image bytes go straight to object storage through presigned URLs (design D4a),
// which is why the bucket allows this origin (see `rustfs-init` in docker-compose.yml).
const apiUrl = process.env.API_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: apiUrl, rewrite: (path) => path.replace(/^\/api/, '') },
    },
  },
});
