let mupdfPromise = null;
let assetsBinding = null;

export function configureMupdfAssets(assets) {
  if (!assets) throw new Error('The ASSETS binding is required to load MuPDF.');
  assetsBinding = assets;
}

export function loadMupdf() {
  if (!mupdfPromise) {
    mupdfPromise = initializeMupdf().catch((error) => {
      mupdfPromise = null;
      throw error;
    });
  }
  return mupdfPromise;
}

async function initializeMupdf() {
  if (!assetsBinding) throw new Error('MuPDF assets have not been configured.');

  const response = await assetsBinding.fetch('https://assets.local/vendor/mupdf-wasm.wasm');
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
