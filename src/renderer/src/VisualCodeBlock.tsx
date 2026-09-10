import React from 'react';
import DOMPurify from 'dompurify';

type Props = { language: string; source: string };
type VisualState = { svg?: string; error?: string };

const svgCache = new Map<string, VisualState>();

function cacheKey(language: string, source: string) { return language + '\u0000' + source; }
function readCache(language: string, source: string) { return svgCache.get(cacheKey(language, source)); }
function writeCache(language: string, source: string, state: VisualState) {
  if (!state.svg) return state;
  const key = cacheKey(language, source);
  svgCache.delete(key);
  svgCache.set(key, state);
  if (svgCache.size > 100) svgCache.delete(svgCache.keys().next().value as string);
  return state;
}

const WORKER_SOURCE = String.raw`
const esc=(s)=>String(s).replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function tokens(source){const out=[];let i=0;while(i<source.length){const c=source[i];if(/\s/.test(c)){i++;continue}if(/[0-9.]/.test(c)){let j=i+1;while(j<source.length&&/[0-9.eE+-]/.test(source[j])){if(/[+-]/.test(source[j])&&!/[eE]/.test(source[j-1]))break;j++}out.push({t:'n',v:Number(source.slice(i,j))});i=j;continue}if(/[A-Za-z_]/.test(c)){let j=i+1;while(j<source.length&&/[A-Za-z0-9_]/.test(source[j]))j++;out.push({t:'id',v:source.slice(i,j)});i=j;continue}if('+-*/^(),'.includes(c)){out.push({t:c,v:c});i++;continue}throw new Error('Unsupported character: '+c)}return out}
function compile(source){const ts=tokens(source);let p=0;const peek=()=>ts[p];const take=(t)=>{const x=ts[p];if(!x||x.t!==t)throw new Error('Expected '+t);p++;return x};function primary(){const x=peek();if(!x)throw new Error('Unexpected end');if(x.t==='n'){p++;return()=>x.v}if(x.t==='id'){p++;const name=x.v;if(peek()&&peek().t==='('){p++;const arg=expr();take(')');const fn={sin:Math.sin,cos:Math.cos,tan:Math.tan,exp:Math.exp,log:Math.log,sqrt:Math.sqrt,abs:Math.abs}[name];if(!fn)throw new Error('Unsupported function: '+name);return(x)=>fn(arg(x))}if(name==='x')return(x)=>x;if(name==='pi')return()=>Math.PI;if(name==='e')return()=>Math.E;throw new Error('Unsupported identifier: '+name)}if(x.t==='('){p++;const value=expr();take(')');return value}if(x.t==='-'){p++;const value=primary();return(x)=>-value(x)}throw new Error('Invalid expression')}function power(){let left=primary();while(peek()&&peek().t==='^'){p++;const right=primary(),base=left;left=(x)=>Math.pow(base(x),right(x))}return left}function term(){let left=power();while(peek()&&/[*/]/.test(peek().t)){const op=ts[p++].t,right=power(),base=left;left=op==='*'?(x)=>base(x)*right(x):(x)=>base(x)/right(x)}return left}function expr(){let left=term();while(peek()&&/[+-]/.test(peek().t)){const op=ts[p++].t,right=term(),base=left;left=op==='+'?(x)=>base(x)+right(x):(x)=>base(x)-right(x)}return left}const fn=expr();if(p!==ts.length)throw new Error('Unexpected token');return fn}
function plot(source){let spec;try{spec=JSON.parse(source)}catch(_){spec={functions:source.split(/\r?\n/).filter(Boolean).map((expr)=>({expr}))}}const width=720,height=360,pad=35;const xr=spec.x||[-10,10],yr=spec.y||[-10,10];const sx=(x)=>pad+(x-xr[0])/(xr[1]-xr[0])*(width-pad*2),sy=(y)=>height-pad-(y-yr[0])/(yr[1]-yr[0])*(height-pad*2);const colors=['#4daafc','#e06c75','#98c379','#c678dd','#e5c07b'];const paths=(spec.functions||[]).slice(0,8).map((row,index)=>{const expr=typeof row==='string'?row:row.expr;const fn=compile(expr);let d='';let pen=false;for(let i=0;i<=800;i++){const x=xr[0]+(xr[1]-xr[0])*i/800,y=fn(x),valid=Number.isFinite(y)&&y>yr[0]-100&&y<yr[1]+100;if(!valid){pen=false;continue}d+=(pen?'L':'M')+sx(x).toFixed(2)+' '+sy(y).toFixed(2)+' ';pen=true}return '<path d="'+d+'" fill="none" stroke="'+(row.color||colors[index%colors.length])+'" stroke-width="2"/><text x="'+(pad+8)+'" y="'+(pad+18*index)+'" fill="currentColor" font-size="12">'+esc(expr)+'</text>'}).join('');return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+width+' '+height+'" role="img"><rect width="100%" height="100%" fill="transparent"/><path d="M'+sx(xr[0])+' '+sy(0)+'H'+sx(xr[1])+'M'+sx(0)+' '+sy(yr[0])+'V'+sy(yr[1])+'" stroke="#808080" stroke-width="1"/>'+paths+'</svg>'}
function typst(source){const width=720,height=360;let shapes='';for(const line of source.split(/\r?\n/)){let m=line.match(/line\s*\(\s*\(([-\d.]+),\s*([-\d.]+)\)\s*,\s*\(([-\d.]+),\s*([-\d.]+)\)/);if(m)shapes+='<line x1="'+(Number(m[1])*50+width/2)+'" y1="'+(height/2-Number(m[2])*50)+'" x2="'+(Number(m[3])*50+width/2)+'" y2="'+(height/2-Number(m[4])*50)+'" stroke="#4daafc" stroke-width="2"/>';m=line.match(/circle\s*\(\s*\(([-\d.]+),\s*([-\d.]+)\).*?radius\s*:\s*([-\d.]+)/);if(m)shapes+='<circle cx="'+(Number(m[1])*50+width/2)+'" cy="'+(height/2-Number(m[2])*50)+'" r="'+(Number(m[3])*50)+'" fill="none" stroke="#e06c75" stroke-width="2"/>'}return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+width+' '+height+'"><rect width="100%" height="100%" fill="transparent"/><path d="M0 '+height/2+'H'+width+'M'+width/2+' 0V'+height+'" stroke="#707070"/>'+shapes+'<text x="18" y="28" fill="currentColor" font-size="13">Typst/CeTZ isolated preview</text></svg>'}
self.onmessage=(event)=>{try{const {language,source}=event.data;self.postMessage({svg:language==='wa-plot'?plot(source):typst(source)})}catch(error){self.postMessage({error:error.message})}};
`;

function IsolatedSvg({ language, source }: Props) {
  const [state, setState] = React.useState<VisualState>(() => readCache(language, source) || {});
  React.useEffect(() => {
    const cached = readCache(language, source);
    if (cached) { setState(cached); return; }
    setState({});
    const blob = new Blob([WORKER_SOURCE], { type: 'text/javascript' });
    const workerUrl = URL.createObjectURL(blob);
    const worker = new Worker(workerUrl);
    const timer = window.setTimeout(() => { worker.terminate(); URL.revokeObjectURL(workerUrl); setState(writeCache(language, source, { error: '渲染超时' })); }, 1800);
    worker.onmessage = (event) => { window.clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(workerUrl); setState(writeCache(language, source, event.data)); };
    worker.postMessage({ language, source: source.slice(0, 50000) });
    return () => { window.clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(workerUrl); };
  }, [language, source]);
  if (state.error) return <VisualError source={source} error={state.error} />;
  return <VisualCard language={language} source={source} svg={state.svg || ''} />;
}

function MermaidSvg({ source }: { source: string }) {
  const [state, setState] = React.useState<VisualState>(() => readCache('mermaid', source) || {});
  React.useEffect(() => {
    const cached = readCache('mermaid', source);
    if (cached) { setState(cached); return; }
    setState({});
    let active = true;
    import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base', maxTextSize: 50000 });
      return mermaid.render('wa-mermaid-' + Math.random().toString(36).slice(2), source.slice(0, 50000));
    }).then(({ svg }) => { if (active) setState(writeCache('mermaid', source, { svg: DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } }) })); })
      .catch((error) => { if (active) setState(writeCache('mermaid', source, { error: error.message })); });
    return () => { active = false; };
  }, [source]);
  if (state.error) return <VisualError source={source} error={state.error} />;
  return <VisualCard language="mermaid" source={source} svg={state.svg || ''} />;
}

function TypstSvg({ source }: { source: string }) {
  const [state, setState] = React.useState<VisualState>(() => readCache('typst', source) || {});
  React.useEffect(() => {
    const cached = readCache('typst', source);
    if (cached) { setState(cached); return; }
    setState({});
    const worker = new Worker(new URL('./typst.worker.ts', import.meta.url), { type: 'module' });
    const timer = window.setTimeout(() => { worker.terminate(); setState(writeCache('typst', source, { error: 'Typst WASM 渲染超时' })); }, 5000);
    worker.onmessage = (event) => { window.clearTimeout(timer); worker.terminate(); setState(writeCache('typst', source, event.data)); };
    worker.postMessage({ source });
    return () => { window.clearTimeout(timer); worker.terminate(); };
  }, [source]);
  if (state.error) return <VisualError source={source} error={state.error} />;
  return <VisualCard language="typst/wasm" source={source} svg={state.svg || ''} />;
}

function VisualError({ source, error }: { source: string; error: string }) {
  return <details className="visual-error"><summary>可视化无法渲染：{error}</summary><pre>{source}</pre></details>;
}

function VisualLoading() {
  return <figure className="visual-card visual-loading" aria-busy="true"><div className="visual-skeleton" /></figure>;
}

function VisualCard({ language, source, svg }: { language: string; source: string; svg: string }) {
  if (!svg) return <VisualLoading />;
  const safe = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
  const download = (content: string, extension: string, type: string) => {
    const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([content], { type })); link.download = `webagent-visual.${extension}`; link.click(); URL.revokeObjectURL(link.href);
  };
  return <figure className="visual-card"><header><span>{language}</span><div><button onClick={() => download(safe, 'svg', 'image/svg+xml')}>SVG</button><button onClick={() => download(source, 'txt', 'text/plain')}>源码</button></div></header><div className="visual-canvas" dangerouslySetInnerHTML={{ __html: safe }} /></figure>;
}

export const VisualCodeBlock = React.memo(function VisualCodeBlock({ language, source }: Props) {
  if (language === 'mermaid') return <MermaidSvg source={source} />;
  if (language === 'wa-plot') return <IsolatedSvg language={language} source={source} />;
  if (language === 'typst' && /^\s*\/\/\s*@plot/m.test(source)) return <TypstSvg source={source} />;
  return <pre><code className={'language-' + language}>{source}</code></pre>;
});
