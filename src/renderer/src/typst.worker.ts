import { $typst } from '@myriaddreamin/typst.ts';
import { TypstSnippet } from '@myriaddreamin/typst.ts/contrib/snippet';
import compilerWasm from '@myriaddreamin/typst-ts-web-compiler/wasm?url';
import rendererWasm from '@myriaddreamin/typst-ts-renderer/wasm?url';
import bundledFont from 'katex/dist/fonts/KaTeX_Main-Regular.ttf?url';

let initialized = false;

async function initialize() {
  if (initialized) return;
  $typst.setCompilerInitOptions({ getModule: () => compilerWasm });
  $typst.setRendererInitOptions({ getModule: () => rendererWasm });
  $typst.use(TypstSnippet.disableDefaultFontAssets(), TypstSnippet.preloadFontFromUrl(bundledFont));
  initialized = true;
}

self.onmessage = async (event: MessageEvent<{ source: string }>) => {
  try {
    const source = String(event.data.source || '');
    if (source.length > 50000) throw new Error('Typst source exceeds 50 KB');
    if (/#import\s+['"]@|https?:\/\/|#read\s*\(|#raw\s*\(/i.test(source)) throw new Error('External packages, network URLs, and file reads are disabled');
    await initialize();
    const mainContent = source.replace(/^\s*\/\/\s*@plot\s*\r?\n/, '');
    const svg = await $typst.svg({ mainContent });
    self.postMessage({ svg });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
