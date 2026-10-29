// Runs the Demucs model off the main thread.
// NOTE: check the demucs-web README if the constructor/separate() names differ in your version.
import * as ort from 'onnxruntime-web';
import { DemucsProcessor } from 'demucs-web';
// Tell the runtime where its .wasm files live (same version as installed). Without this it can fetch index.html instead and fail.
ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.web}/dist/`;
const MODEL = 'https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx';
self.onmessage = async ({ data: { left, right } }) => {
  try {
    const p = new DemucsProcessor({ ort, onProgress: (e) => self.postMessage({ type: 'progress', value: e.progress }) });
    await p.loadModel(MODEL);
    const r = await p.separate(left, right);
    const stems = {}, transfer = [];
    for (const k of ['vocals', 'drums', 'bass', 'other']) {
      stems[k] = [r[k].left, r[k].right];
      transfer.push(r[k].left.buffer, r[k].right.buffer);
    }
    self.postMessage({ type: 'done', stems }, transfer);
  } catch (e) { self.postMessage({ type: 'error', message: String(e) }); }
};
