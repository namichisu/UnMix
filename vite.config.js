import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// The model runtime needs these headers (SharedArrayBuffer)
const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
export default defineConfig({ plugins: [react()], worker: { format: 'es' }, optimizeDeps: { exclude: ['onnxruntime-web'] }, server: { headers }, preview: { headers } });
