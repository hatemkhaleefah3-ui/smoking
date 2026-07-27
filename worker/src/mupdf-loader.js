import mupdfWasm from '../../node_modules/mupdf/dist/mupdf-wasm.wasm';

let mupdfPromise = null;

export function loadMupdf() {
  if (!mupdfPromise) {
    globalThis.$libmupdf_wasm_Module = createModuleOptions(mupdfWasm);
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

function createModuleOptions(wasm) {
  if (typeof WebAssembly !== 'undefined' && wasm instanceof WebAssembly.Module) {
    return {
      instantiateWasm(imports, successCallback) {
        const instance = new WebAssembly.Instance(wasm, imports);
        successCallback(instance, wasm);
        return instance.exports;
      }
    };
  }
  const wasmBinary = wasm instanceof Uint8Array ? wasm : new Uint8Array(wasm);
  return { wasmBinary };
}
