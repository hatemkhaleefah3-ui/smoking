let mupdfPromise = null;

export function loadMupdf(env) {
  if (!mupdfPromise) {
    mupdfPromise = initializeMupdf(env).catch((error) => {
      mupdfPromise = null;
      throw error;
    });
  }
  return mupdfPromise;
}

async function initializeMupdf(env) {
  if (!env?.ASSETS) throw new Error('The ASSETS binding is required to load MuPDF.');

  const response = await env.ASSETS.fetch('https://assets.local/vendor/mupdf-wasm.wasm');
  if (!response.ok) throw new Error(`MuPDF WASM asset could not be loaded (${response.status}).`);

  const wasmBinary = new Uint8Array(await response.arrayBuffer());
  globalThis.$libmupdf_wasm_Module = { wasmBinary };

  try {
    const module = await import('mupdf');
    return module.default || module;
  } finally {
    delete globalThis.$libmupdf_wasm_Module;
  }
}
