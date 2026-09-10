'use strict';

function createChatGPTServer(getView) {
  const model = {
    id: 'chatgpt.web', displayName: 'ChatGPT 网页（实验性）', provider: 'chatgpt',
    capabilities: { inputMaxLen: 128000, file: { maxMB: 0, maxCount: 0, types: [] }, multimodal: { input: ['text', 'image'], output: ['text'] }, deepThink: false, webSearch: false }
  };
  const js = async (source) => {
    const view = getView && getView();
    if (!view || !view.webContents || view.webContents.isDestroyed()) throw new Error('ChatGPT Worker unavailable');
    let lastError = null;
    for (let attempt = 0; attempt < 75; attempt += 1) {
      try { return await view.webContents.executeJavaScript(source, true); }
      catch (error) {
        lastError = error;
        if (view.webContents.isDestroyed() || !/Script failed to execute|context.*destroyed|frame.*detached/i.test(String(error && error.message || error))) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    throw lastError || new Error('ChatGPT page context did not stabilize');
  };
  let responseBaseline = { count: 0, text: '' };
  const extract = () => js(`(function(){
    const candidates=Array.from(document.querySelectorAll('[data-message-author-role="assistant"], article [class*="markdown"], main article'));
    const node=candidates[candidates.length-1];
    function codeLanguage(pre,code){
      const direct=[code&&code.className,pre&&pre.className,code&&code.getAttribute('data-language'),pre&&pre.getAttribute('data-language')].filter(Boolean).join(' ');
      const matched=direct.match(/(?:language-|lang-)?(wa-plot|mermaid|typst|javascript|typescript|python|json|bash|shell|css|html|svg)\b/i);
      if(matched)return matched[1].toLowerCase();
      let current=pre;
      for(let depth=0;current&&depth<4;depth++,current=current.parentElement){
        const labels=Array.from(current.children||[]).filter(function(child){return child!==pre&&!child.contains(pre)}).map(function(child){return (child.innerText||child.textContent||'').trim()});
        const label=labels.join(' ').match(/\b(wa-plot|mermaid|typst|javascript|typescript|python|json|bash|shell|css|html|svg)\b/i);
        if(label)return label[1].toLowerCase();
      }
      return '';
    }
    function markdown(root){
      // ChatGPT may split a visually continuous plain-text answer across
      // transient layout nodes while streaming. innerText reflects the final
      // visible line layout; use it unless Markdown structure must be kept.
      if(root&&!root.querySelector('pre,code,h1,h2,h3,h4,h5,h6,ul,ol,blockquote,a[href],strong,b,em,i')){
        return (root.innerText||root.textContent||'').replace(/\\n{3,}/g,'\\n\\n').trim();
      }
      function walk(value){
        if(!value)return '';
        if(value.nodeType===Node.TEXT_NODE)return value.nodeValue||'';
        if(value.nodeType!==Node.ELEMENT_NODE)return '';
        const tag=value.tagName.toLowerCase();
        if(tag==='pre'){
          const code=value.querySelector('code')||value;
          return '\\n\`\`\`'+codeLanguage(value,code)+'\\n'+(code.innerText||code.textContent||'').replace(/\\n+$/,'')+'\\n\`\`\`\\n';
        }
        if(tag==='br')return '\\n';
        const content=Array.from(value.childNodes).map(walk).join('');
        if(tag==='code')return '\`'+content+'\`';
        if(tag==='strong'||tag==='b')return '**'+content+'**';
        if(tag==='em'||tag==='i')return '*'+content+'*';
        if(tag==='a'){const href=value.getAttribute('href')||'';return href?'['+content+']('+href+')':content}
        if(/^h[1-6]$/.test(tag))return '\\n'+'#'.repeat(Number(tag[1]))+' '+content.trim()+'\\n';
        if(tag==='li')return '\\n- '+content.trim();
        // ChatGPT uses nested divs for inline token/layout wrappers. Treating
        // every div as a paragraph can split a word across artificial lines.
        if(['p','section','article','ul','ol','blockquote'].includes(tag))return '\\n'+content.trim()+'\\n';
        return content;
      }
      return walk(root).replace(/\\n[ \\t]+/g,'\\n').replace(/\\n{3,}/g,'\\n\\n').trim();
    }
    const title=(document.title||'').replace(/\s*[-–|]\s*ChatGPT.*$/i,'').trim();
    return {markdown:node?markdown(node):'',think:'',title:title,url:location.href};
  })()`);
  const clickPoint = async (point) => {
    const view = getView && getView();
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || !view || !view.webContents || view.webContents.isDestroyed()) return false;
    view.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
    view.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    view.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    return true;
  };
  async function invoke(_modelId, op, args) {
    args = args || {};
    try {
      if (op === 'listModels') return { success: true, data: [model] };
      if (op === 'getCapabilities') return { success: true, data: model.capabilities };
      if (op === 'newChat') {
        const view = getView && getView();
        if (view && !view.webContents.isDestroyed() && !/^https:\/\/chatgpt\.com\/?(?:\?|$)/.test(view.webContents.getURL())) await view.webContents.loadURL('https://chatgpt.com/');
        if (args.userText) { const sent = await invoke(_modelId, 'sendMessage', { text: args.userText }); return sent.success ? { success: true, data: { conversationUrl: '' } } : sent; }
        return { success: true, data: { conversationUrl: '' } };
      }
      if (op === 'sendMessage') {
        const rawText = String(args.text || '');
        let prepared = await js(`(async function(){
          const visible=function(node){if(!node)return false;const rect=node.getBoundingClientRect();const style=getComputedStyle(node);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden'};
          const editors=Array.from(document.querySelectorAll('#prompt-textarea.ProseMirror,div.ProseMirror[contenteditable="true"],[contenteditable="true"][role="textbox"],#prompt-textarea,textarea')).filter(visible);
          const editor=editors.find(function(node){return node.isContentEditable&&node.classList.contains('ProseMirror')})||editors.find(function(node){return node.isContentEditable})||editors[0];
          if(!editor)return {ok:false,error:'ChatGPT editor not found'};
          const assistants=Array.from(document.querySelectorAll('[data-message-author-role="assistant"],main article')).filter(function(node){return (node.innerText||node.textContent||'').trim()});
          const users=Array.from(document.querySelectorAll('[data-message-author-role="user"]')).filter(function(node){return (node.innerText||node.textContent||'').trim()});
          const lastAssistant=assistants[assistants.length-1];
          const lastUser=users[users.length-1];
          const rect=editor.getBoundingClientRect();
          return {ok:true,editorX:Math.round(rect.left+Math.min(rect.width/2,120)),editorY:Math.round(rect.top+rect.height/2),before:location.href,assistantCount:assistants.length,lastAssistantText:lastAssistant?(lastAssistant.innerText||lastAssistant.textContent||'').trim():'',userCount:users.length,lastUserText:lastUser?(lastUser.innerText||lastUser.textContent||'').trim():''};
        })()`);
        if (!prepared || !prepared.ok) return { success: false, error: prepared && prepared.error || 'Unable to prepare ChatGPT message' };
        const sendBaseline = { count: Number(prepared.assistantCount) || 0, text: String(prepared.lastAssistantText || '') };
        const userBaseline = { count: Number(prepared.userCount) || 0, text: String(prepared.lastUserText || '') };
        const view = getView && getView();
        if (!view || !view.webContents || view.webContents.isDestroyed()) return { success: false, error: 'ChatGPT Worker unavailable' };

        await clickPoint({ x: prepared.editorX, y: prepared.editorY });
        view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
        view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
        view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
        view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
        if (typeof view.webContents.insertText === 'function') await view.webContents.insertText(rawText);
        else return { success: false, error: 'ChatGPT trusted text insertion is unavailable' };

        const locateSend = async () => js(`(async function(){
          const visible=function(node){if(!node)return false;const rect=node.getBoundingClientRect();const style=getComputedStyle(node);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden'};
          for(let attempt=0;attempt<40;attempt+=1){
            const sendButtons=Array.from(document.querySelectorAll('[data-testid="send-button"],#composer-submit-button,button[type="submit"],button[aria-label*="Send" i],button[aria-label*="发送"],button.composer-submit-button-color'));
            const send=sendButtons.find(function(button){const label=(button.getAttribute('aria-label')||'').trim();return visible(button)&&!button.disabled&&!/语音|voice|dictation|听写|stop|停止/i.test(label)});
            if(send){const rect=send.getBoundingClientRect();return {ok:true,x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)}}
            await new Promise(function(resolve){setTimeout(resolve,100)});
          }
          return {ok:false,error:'ChatGPT send button not found or remained disabled'};
        })()`);
        prepared = Object.assign(prepared, await locateSend());
        if (!prepared.ok) return { success: false, error: prepared.error || 'ChatGPT send button not found' };

        for (let submitAttempt = 0; submitAttempt < 3; submitAttempt += 1) {
          if (submitAttempt === 1) {
            view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
            view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
          } else {
            await clickPoint({ x: prepared.x, y: prepared.y });
          }
          for (let verifyAttempt = 0; verifyAttempt < 40; verifyAttempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            let accepted = false;
            try {
              accepted = await js(`(function(){
                const visible=function(node){if(!node)return false;const rect=node.getBoundingClientRect();const style=getComputedStyle(node);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden'};
                const editor=Array.from(document.querySelectorAll('#prompt-textarea.ProseMirror,div.ProseMirror[contenteditable="true"],[contenteditable="true"][role="textbox"],#prompt-textarea,textarea')).find(function(node){return visible(node)&&(node.isContentEditable||node.tagName==='TEXTAREA')});
                const remaining=editor?(editor.isContentEditable?(editor.innerText||editor.textContent||''):editor.value):'';
                const users=Array.from(document.querySelectorAll('[data-message-author-role="user"]')).filter(function(node){return (node.innerText||node.textContent||'').trim()});
                const lastUser=users[users.length-1];
                const lastUserText=lastUser?(lastUser.innerText||lastUser.textContent||'').trim():'';
                const stop=Array.from(document.querySelectorAll('[data-testid="stop-button"],button[aria-label*="Stop" i],button[aria-label*="停止"]')).some(visible);
                return !remaining.trim()||location.href!==${JSON.stringify(prepared.before)}||stop||users.length>${userBaseline.count}||(lastUserText&&lastUserText!==${JSON.stringify(userBaseline.text)});
              })()`);
            } catch (error) {
              if (!view.webContents.isDestroyed()) {
                await new Promise((resolve) => setTimeout(resolve, 200));
                accepted = view.webContents.getURL() !== prepared.before;
              } else throw error;
            }
            if (accepted) { responseBaseline = sendBaseline; return { success: true }; }
          }
          const relocated = await locateSend();
          if (!relocated || !relocated.ok) break;
          prepared = Object.assign(prepared, relocated);
        }
        return { success: false, error: 'ChatGPT did not accept the trusted send action' };
      }
      if (op === 'waitForDone') {
        const deadline = Date.now() + Math.min(Number(args.timeout) || 180000, 600000);
        let previous = '', stable = 0, retryCount = 0;
        while (Date.now() < deadline) {
          let state;
          try {
            state = await js(`(function(){
              const visible=function(node){if(!node)return false;const rect=node.getBoundingClientRect();const style=getComputedStyle(node);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden'};
              const stopNode=document.querySelector('[data-testid="stop-button"],button[aria-label*="Stop" i],button[aria-label*="停止"]');
              const c=Array.from(document.querySelectorAll('[data-message-author-role="assistant"],main article'));const n=c[c.length-1];
              const complete=Array.from(document.querySelectorAll('button')).some(function(button){return /复制消息|copy message/i.test(button.getAttribute('aria-label')||'')});
               const retry=Array.from(document.querySelectorAll('button')).find(function(button){const text=(button.innerText||button.textContent||'').trim();return visible(button)&&/^(try again|retry|\u91cd\u8bd5|\u518d\u8bd5\u4e00\u6b21)$/i.test(text)});
               let retryPoint=null;if(retry&&/(content failed to load|something went wrong|\u5185\u5bb9\u52a0\u8f7d\u5931\u8d25|\u51fa\u9519\u4e86)/i.test(document.body.innerText||'')){const r=retry.getBoundingClientRect();retryPoint={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}}
               return {stop:visible(stopNode),complete:complete,count:c.length,text:n?(n.innerText||n.textContent||'').trim():'',retryPoint};
             })()`);
          } catch (_) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            continue;
          }
          if (state.retryPoint) {
            if (retryCount >= 2) return { success: false, error: 'ChatGPT content failed to load after retries' };
            retryCount += 1;
            await clickPoint(state.retryPoint);
            await new Promise((resolve) => setTimeout(resolve, 1000));
            previous = '';
            stable = 0;
            continue;
          }
          const isNewResponse = Number(state.count) > responseBaseline.count || !!(state.text && state.text !== responseBaseline.text);
          if (!isNewResponse) { await new Promise((resolve) => setTimeout(resolve, 500)); continue; }
          stable = state.text && state.text === previous ? stable + 1 : 0; previous = state.text || previous;
          if (previous && ((state.complete && stable >= 2) || (!state.stop && stable >= 3) || stable >= 12)) return { success: true, data: { done: true, completionSignal: state.complete ? 'copy_action' : state.stop ? 'stable_text' : 'stop_removed' } };
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        return { success: false, error: 'ChatGPT response timeout' };
      }
      if (op === 'peekResponse') { const data = await extract(); return { success: true, data: { text: data.markdown, markdown: data.markdown } }; }
      if (op === 'extractResponse') return { success: true, data: await extract() };
      if (op === 'getConversationMetadata') { const data = await extract(); return { success: true, data: { title: data.title, url: data.url } }; }
      if (op === 'listConversations') {
        const data = await js(`(function(){
          const rows=[];const seen=new Set();
          for(const anchor of document.querySelectorAll('a[href*="/c/"]')){
            let url='';try{const parsed=new URL(anchor.href,location.href);const parts=parsed.pathname.split('/').filter(Boolean);if(parts.length!==2||parts[0]!=='c'||!parts[1])continue;const pathname=parsed.pathname.endsWith('/')?parsed.pathname.slice(0,-1):parsed.pathname;url=parsed.origin+pathname}catch(_){continue}
            if(seen.has(url))continue;seen.add(url);
            const title=(anchor.innerText||anchor.textContent||anchor.getAttribute('aria-label')||'').trim();
            rows.push({title:title.slice(0,160),url});
          }
          return rows;
        })()`);
        return { success: true, data: Array.isArray(data) ? data : [] };
      }
      if (op === 'stopGeneration') { await js(`(function(){const b=document.querySelector('[data-testid="stop-button"],button[aria-label*="Stop" i]');if(b)b.click()})()`); return { success: true }; }
      if (op === 'deleteConversation') {
        const target = String(args.convid || args._conversationUrl || '');
        let targetUrl;
        try { const parsed = new URL(target); targetUrl = parsed.origin + parsed.pathname.replace(/\/$/, ''); }
        catch (_) { return { success: false, error: 'Invalid ChatGPT conversation URL' }; }
        const locate = async () => js(`(function(){
          const wanted=${JSON.stringify(targetUrl)};
          const anchor=Array.from(document.querySelectorAll('a[href*="/c/"]')).find(function(node){try{const u=new URL(node.href,location.href);const p=u.pathname.endsWith('/')?u.pathname.slice(0,-1):u.pathname;return u.origin+p===wanted}catch(_){return false}});
          // Older conversations may be absent from the lazily loaded sidebar
          // even while their exact /c/<id> route is open.  In that case the
          // header menu is still the authoritative deletion surface.
          if(!anchor){
            const current=location.origin+location.pathname.replace(/\\/$/,'');
            if(current===wanted)return {found:true,direct:true,title:(document.title||'').replace(/\\s*[-–|]\\s*ChatGPT.*$/i,'').trim(),hover:null,option:null};
            return {found:false};
          }
          const row=anchor.closest('li,[data-testid*="conversation"],div.group')||anchor.parentElement;
          const anchorRect=anchor.getBoundingClientRect();const rect=(row||anchor).getBoundingClientRect();
          const buttons=Array.from(document.querySelectorAll('button'));
          const option=buttons.find(function(button){
            const label=(button.getAttribute('aria-label')||button.getAttribute('data-testid')||'');
            if(!/conversation options|chat options|options|\u5bf9\u8bdd\u9009\u9879|\u804a\u5929\u9009\u9879|\u9009\u9879/i.test(label))return false;
            const r=button.getBoundingClientRect();return r.width>0&&r.height>0&&Math.abs((r.top+r.bottom)/2-(anchorRect.top+anchorRect.bottom)/2)<12;
          });
          let optionPoint=null;if(option){const r=option.getBoundingClientRect();if(r.width&&r.height)optionPoint={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}}
          return {found:true,title:(anchor.innerText||anchor.textContent||anchor.getAttribute('aria-label')||'').trim(),hover:{x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)},option:optionPoint};
         })()`);
        const findDirectOptionPoint = async () => js(`(function(){
          const visible=function(node){const r=node.getBoundingClientRect(),s=getComputedStyle(node);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'};
          const buttons=Array.from(document.querySelectorAll('button')).filter(visible);
          const option=buttons.find(function(button){
            const label=(button.getAttribute('aria-label')||button.getAttribute('data-testid')||button.innerText||button.textContent||'').trim();
            return /conversation options|chat options|more actions|more options|\\u5bf9\\u8bdd\\u9009\\u9879|\\u804a\\u5929\\u9009\\u9879|\\u66f4\\u591a\\u64cd\\u4f5c|\\u66f4\\u591a\\u9009\\u9879/i.test(label);
          });
          if(!option)return null;const r=option.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
        })()`);
        // A direct /c/<id> URL can survive in the address bar after ChatGPT has
        // already removed that conversation.  Treat it as remotely deleted only
        // when the page itself confirms the generic, message-free empty state.
        // This avoids leaving an undeletable local tombstone for a remote chat
        // which no longer has a sidebar row or a header actions menu.
        const inspectDirectTarget = async () => js(`(function(){
          const wanted=${JSON.stringify(targetUrl)};
          const normalise=function(value){try{const u=new URL(value,location.href);return u.origin+u.pathname.replace(/\\/$/,'')}catch(_){return ''}};
          const exact=normalise(location.href)===wanted;
          const hasSidebarRow=Array.from(document.querySelectorAll('a[href*="/c/"]')).some(function(node){return normalise(node.href)===wanted});
          const hasMessages=Boolean(document.querySelector('[data-message-author-role],main article,[data-testid*="conversation-turn"]'));
          const title=(document.title||'').trim().toLowerCase();
          const genericTitle=!title||title==='chatgpt'||/^chatgpt\\s*[-–|]/i.test(title);
          const loading=Boolean(document.querySelector('[role="progressbar"],[data-testid*="loading" i]'));
          return {exact,hasSidebarRow,hasMessages,genericTitle,loading};
        })()`);
        const findConfirmPoint = async (title) => js(`(function(){
          const wantedTitle=${JSON.stringify(String(title || '').trim())};
          const visible=function(node){const r=node.getBoundingClientRect(),s=getComputedStyle(node);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'};
          const buttons=Array.from(document.querySelectorAll('button')).filter(visible);
          const deleteButtons=buttons.filter(function(node){const t=(node.innerText||node.textContent||node.getAttribute('aria-label')||'').trim();return /^(delete|\u5220\u9664)$/i.test(t)});
          for(const button of deleteButtons){
            let root=button.parentElement;
            for(let depth=0;root&&depth<8;depth++,root=root.parentElement){
              const rootButtons=Array.from(root.querySelectorAll('button')).filter(visible);
              const hasCancel=rootButtons.some(function(node){const t=(node.innerText||node.textContent||node.getAttribute('aria-label')||'').trim();return /^(cancel|\u53d6\u6d88)$/i.test(t)});
              const text=(root.innerText||root.textContent||'').trim();
              const isDeleteDialog=/(delete (chat|conversation)|\u5220\u9664\u804a\u5929|\u5220\u9664\u5bf9\u8bdd)/i.test(text);
              const titleMatches=!wantedTitle||text.includes(wantedTitle);
              if(hasCancel&&isDeleteDialog&&titleMatches){const r=button.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}}
            }
          }
          return null;
        })()`);
        const waitUntilRemoved = async (direct) => {
          const deadline = Date.now() + 15000;
          while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 300));
            if (direct) {
              const state = await inspectDirectTarget();
              if (state && (!state.exact || (!state.hasSidebarRow && !state.hasMessages && state.genericTitle && !state.loading))) return true;
            }
            const remains = await js(`(function(){const wanted=${JSON.stringify(targetUrl)};return Array.from(document.querySelectorAll('a[href*="/c/"]')).some(function(node){try{const u=new URL(node.href,location.href);const p=u.pathname.endsWith('/')?u.pathname.slice(0,-1):u.pathname;return u.origin+p===wanted}catch(_){return false}})})()`);
            if (!remains) return true;
          }
          return false;
        };
        let row = await locate();
        if (!row || !row.found) return { success: false, error: 'Exact ChatGPT conversation was not found in the sidebar' };
        const existingConfirmPoint = await findConfirmPoint(row.title);
        if (existingConfirmPoint) {
          if (!(await clickPoint(existingConfirmPoint))) return { success: false, error: 'ChatGPT delete confirmation button could not be clicked' };
          if (await waitUntilRemoved(!!row.direct)) return { success: true, data: { deleted: targetUrl } };
          return { success: false, error: 'ChatGPT did not confirm that the conversation was deleted' };
        }
        const view = getView && getView();
        if (row.hover && view && view.webContents && !view.webContents.isDestroyed()) view.webContents.sendInputEvent({ type: 'mouseMove', x: row.hover.x, y: row.hover.y });
        await new Promise((resolve) => setTimeout(resolve, 350));
        row = await locate();
        if (row && row.direct && !row.option) row.option = await findDirectOptionPoint();
        if (row && row.direct && !row.option) {
          const state = await inspectDirectTarget();
          if (state && state.exact && !state.hasSidebarRow && !state.hasMessages && state.genericTitle && !state.loading) {
            return { success: true, data: { deleted: targetUrl, already_missing: true } };
          }
        }
        if (!row.option || !(await clickPoint(row.option))) return { success: false, error: 'ChatGPT conversation options button was not found' };
        await new Promise((resolve) => setTimeout(resolve, 400));
        const menuPoint = await js(`(function(){
          const visible=function(node){const r=node.getBoundingClientRect(),s=getComputedStyle(node);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'};
          const nodes=Array.from(document.querySelectorAll('[role="menuitem"],button,[role="button"]')).filter(visible);
          const item=nodes.find(function(node){const t=(node.innerText||node.textContent||node.getAttribute('aria-label')||'').trim();return /^(delete|\u5220\u9664)( conversation| chat|\u5bf9\u8bdd)?$/i.test(t)});
          if(!item)return null;const r=item.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
        })()`);
        if (!menuPoint || !(await clickPoint(menuPoint))) return { success: false, error: 'ChatGPT delete menu item was not found' };
        await new Promise((resolve) => setTimeout(resolve, 400));
        const confirmPoint = await findConfirmPoint(row.title);
        if (!confirmPoint || !(await clickPoint(confirmPoint))) return { success: false, error: 'ChatGPT delete confirmation button was not found' };
        if (await waitUntilRemoved(!!row.direct)) return { success: true, data: { deleted: targetUrl } };
        return { success: false, error: 'ChatGPT did not confirm that the conversation was deleted' };
      }
      if (['setDeepThink', 'setWebSearch', 'injectHistory'].includes(op)) return { success: true };
      return { success: false, error: 'Unknown ChatGPT operation: ' + op };
    } catch (error) { return { success: false, error: 'ChatGPT ' + op + ': ' + error.message }; }
  }
  return { models: { [model.id]: model }, invoke };
}

module.exports = { createChatGPTServer };
