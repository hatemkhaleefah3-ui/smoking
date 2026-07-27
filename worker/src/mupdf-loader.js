import mupdfWasm from '../../node_modules/mupdf/dist/mupdf-wasm.wasm';

let mupdfPromise = null;

export function loadMupdf() {
  if (!mupdfPromise) {
    const wasmBinary = mupdfWasm instanceof Uint8Array ? mupdfWasm : new Uint8Array(mupdfWasm);
    globalThis.$libmupdf_wasm_Module = { wasmBinary };
    mupdfPromise = import('mupdf').then((module) => {
      delete globalThis.$libmupdf_wasm_Module;
      return module.default || module;
    }).catch((error) => {
      mupdfPromise = null;
      delete globalThis.$libmupdf_wasm_Module;
      throw error;
    });
  }
  return mupdfPromise;
}
