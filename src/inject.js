import { CROSS_PREFIX, hostOf, SCHEME_RELATIVE_RE } from './url.js';

// 注入到被代理页面 / edgetunnel 面板的 HTML 片段（返回主页按钮、前端 URL 映射脚本）

/**
 * 为 edgetunnel 管理面板 / 登录页注入「返回主页」入口，方便回到统一入口。
 * 优先注入到面板顶部导航（header-buttons），避免被页面 JS 重绘移除；登录页无导航则退回 body 末尾。
 */
function injectHomeButton(html) {
  if (!html) return html;
  const btn = `<a href="/" onclick="location.href='/';return false;" style="display:inline-flex;align-items:center;background:rgba(15,23,42,.9);color:#fff;border:1px solid rgba(255,255,255,.28);border-radius:8px;padding:8px 16px;font-size:13px;text-decoration:none;font-family:system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;margin-right:8px;box-shadow:0 2px 8px rgba(0,0,0,.3);white-space:nowrap;">← 返回主页</a>\n`;
  if (/<div class="header-buttons">/i.test(html)) {
    return html.replace(/<div class="header-buttons">/i, '<div class="header-buttons">' + btn);
  }
  if (/<\/body>/i.test(html)) {
    const fixed = `<a href="/" onclick="location.href='/';return false;" style="position:fixed;left:14px;bottom:14px;z-index:2147483000;background:rgba(15,23,42,.88);color:#fff;border:1px solid rgba(255,255,255,.28);border-radius:999px;padding:8px 16px;font-size:13px;text-decoration:none;font-family:system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.35);backdrop-filter:blur(6px);">← 返回主页</a>\n`;
    return html.replace(/<\/body>/i, fixed + '</body>');
  }
  return html + btn;
}

/**
 * 为反代页注入「统一 URL 映射」脚本（与后端 rewriteContent 同一套规则，对任何站点行为一致）。
 *
 * 为什么需要它：页面 JS 在运行时会用原站路径重建 DOM、发起请求、改写地址栏，
 * 服务端重写过的 HTML 会被覆盖，导致链接点不动 / 数据取不到 / 跳回代理主页。
 * 这里在浏览器侧补齐同一层映射，使"页面看到的一切 URL"始终落在代理命名空间内：
 *   - MutationObserver：修复运行时新增/重建的 a[href]、form[action]、img[src] 等
 *   - fetch / XHR / WebSocket / EventSource：请求 URL 走代理
 *   - history.pushState / replaceState / location.assign：地址栏始终带代理前缀
 *   - 捕获阶段拦截点击：凡映射到代理命名空间的链接一律整页跳转，
 *     绕开 SPA 前端路由（它不认识 /p/ 前缀，会吞掉导航导致"点不动"）
 *   - 动态插入的 <base> 移除：避免相对 URL 基准被改回原站
 */

/**
 * 为反代页注入「统一 URL 映射」脚本（与后端 rewriteContent 同一套规则，对任何站点行为一致）。
 *
 * 为什么需要它：页面 JS 在运行时会用原站路径重建 DOM、发起请求、改写地址栏，
 * 服务端重写过的 HTML 会被覆盖，导致链接点不动 / 数据取不到 / 跳回代理主页。
 * 这里在浏览器侧补齐同一层映射，使"页面看到的一切 URL"始终落在代理命名空间内：
 *   - MutationObserver：修复运行时新增/重建的 a[href]、form[action]、img[src] 等
 *   - fetch / XHR / WebSocket / EventSource：请求 URL 走代理
 *   - history.pushState / replaceState / location.assign：地址栏始终带代理前缀
 *   - 捕获阶段拦截点击：凡映射到代理命名空间的链接一律整页跳转，
 *     绕开 SPA 前端路由（它不认识 /p/ 前缀，会吞掉导航导致"点不动"）
 *   - 动态插入的 <base> 移除：避免相对 URL 基准被改回原站
 */
function injectLinkFix(html, site, sitePrefix, base) {
  if (!site || !sitePrefix || !base) return html;
  const H = JSON.stringify(hostOf(site.host));
  const BH = JSON.stringify(hostOf(base.host));
  const P = JSON.stringify(sitePrefix);
  const B = JSON.stringify(base.prefix);
  const X = JSON.stringify(CROSS_PREFIX);
  // 与后端 SCHEME_RELATIVE_RE 完全同源：// 之后必须是合法主机名才算协议相对 URL，
  // 否则保持原样（避免误改注释等文本）
  const REL_SRC = JSON.stringify(SCHEME_RELATIVE_RE.source);
  const script = `<script>
(function(){
  var H=${H}, BH=${BH}, P=${P}, B=${B}, X=${X};
  var REL = new RegExp(${REL_SRC});
  function sub(h, s){ h=String(h||'').toLowerCase(); return !!h && h===String(s||'').toLowerCase(); }
  function abs(u){
    var rest = u.pathname + u.search + u.hash;
    // 幂等：源站回传的 URL 里可能已带代理路径（return_to 等回跳参数），
    // 再套前缀会变成 /p/<id>/p/<id>/... 导致源站 404
    if(u.pathname === P || u.pathname.indexOf(P + '/') === 0) return rest;
    if(u.pathname === B || u.pathname.indexOf(B + '/') === 0) return rest;
    if(sub(u.host, H)) return P + rest;
    if(sub(u.host, BH)) return B + rest;
    return P + X + u.host + rest;
  }
  function inNs(p){ return typeof p==='string' && (p===P || p.indexOf(P+'/')===0); }
  function fix(h){
    if(!h || typeof h!=='string' || h.charAt(0)==='#') return h;
    if(/^[a-z][a-z0-9+.-]*:/i.test(h)){
      if(h.indexOf('http')!==0) return h;              // mailto: / javascript: / data: 等原样保留
      try{ return abs(new URL(h)); }catch(e){ return h; }
    }
    if(h.indexOf('//')===0){ if(!REL.test(h)) return h; try{ return abs(new URL('https:'+h)); }catch(e){ return h; } }
    if(h.charAt(0)==='/' && !inNs(h)) return (sub(BH, H) ? P : B) + h; // 根相对：当前响应域是站点域则归主通道，否则按所属域
    // 修复相对路径（如 ./issues、issues、../settings）无法走代理的问题
    // 相对 URL 浏览器会按当前页地址解析，但某些框架（如 Turbo）会直接拼接导致跳出代理
    if(h.charAt(0) !== '#' && h.charAt(0) !== '?' && !/^[a-z][a-z0-9+.-]*:/i.test(h) && h.indexOf('//') !== 0){
      // 相对路径：补上代理前缀确保走代理
      if(!inNs(h)) return B + (h.charAt(0) === '.' ? h.slice(h.charAt(1) === '/' ? 1 : 0) : '/' + h);
    }
    return h;
  }
  function fixWs(h){
    if(!h || typeof h!=='string') return h;
    var m = h.replace(/^ws/, 'http');
    var f = fix(m);
    return f === m ? h : f;
  }
  function fixEl(el){
    if(!el || el.nodeType!==1 || el._apf) return;
    el._apf = 1;
    if(el.tagName === 'BASE'){ if(el.parentNode) el.parentNode.removeChild(el); return; }
    var attrs = ['href','src','action','poster','data-src','srcset','data-srcset','formaction'];
    for(var i=0;i<attrs.length;i++){
      var a = attrs[i];
      if(!el.hasAttribute || !el.hasAttribute(a)) continue;
      var v = el.getAttribute(a);
      if(a === 'srcset' || a === 'data-srcset'){
        var parts = v.split(',').map(function(s){ return s.trim(); }).filter(Boolean);
        for(var j=0;j<parts.length;j++){
          var seg = parts[j].split(/\\s+/);
          if(seg[0]){ seg[0] = fix(seg[0]); parts[j] = seg.join(' '); }
        }
        var nv = parts.join(', ');
        if(nv !== v) el.setAttribute(a, nv);
      } else {
        var f = fix(v);
        if(f !== v) el.setAttribute(a, f);
      }
    }
  }
  function fixTree(root){
    if(!root) return;
    if(root.nodeType === 1){
      fixEl(root);
      if(root.tagName === 'BASE'){ if(root.parentNode) root.parentNode.removeChild(root); return; }
    }
    if(!root.querySelectorAll) return;
    var all = root.querySelectorAll('[href],[src],[action],[poster],[data-src],[srcset],[data-srcset],[formaction],base');
    for(var i=0;i<all.length;i++){
      var el = all[i];
      if(el.tagName === 'BASE'){ if(el.parentNode) el.parentNode.removeChild(el); continue; }
      fixEl(el);
    }
  }
  // 运行时由 JS 重建的 DOM（React/Vue/turbo 等）持续修复
  if(window.MutationObserver){
    new MutationObserver(function(ms){
      for(var i=0;i<ms.length;i++){
        var nn = ms[i].addedNodes;
        for(var j=0;j<nn.length;j++) fixTree(nn[j]);
        if(ms[i].type === 'attributes' && ms[i].target && ms[i].target.nodeType === 1){
          ms[i].target._apf = 0; fixEl(ms[i].target);
        }
      }
    }).observe(document.documentElement, {subtree:true, childList:true, attributes:true, attributeFilter:['href','src','action','srcset','formaction']});
  }
  // 请求层：fetch / XHR / WebSocket / EventSource
  if(window.fetch){
    var OF = window.fetch;
    window.fetch = function(u, o){
      try{
        if(typeof u === 'string') u = fix(u);
        else if(u && typeof u.url === 'string'){
          var f = fix(u.url);
          if(f !== u.url){ try{ u = new Request(f, u); }catch(e){ u = f; } }
        } else if(u && typeof u.href === 'string'){
          try{ u = new URL(fix(u.href)); }catch(e){}
        }
      }catch(e){}
      return OF.call(this, u, o);
    };
  }
  if(window.XMLHttpRequest){
    var OO = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(m, u){
      try{ u = fix(u); }catch(e){}
      var args = Array.prototype.slice.call(arguments);
      if(args.length > 1) args[1] = u;
      return OO.apply(this, args);
    };
  }
  if(window.WebSocket){
    var OW = window.WebSocket;
    window.WebSocket = function(u, p){
      try{ u = fixWs(u); }catch(e){}
      if(!(this instanceof OW)) return new OW(u, p);
      return new OW(u, p);
    };
    window.WebSocket.prototype = OW.prototype;
    window.WebSocket.CONNECTING = OW.CONNECTING; window.WebSocket.OPEN = OW.OPEN;
    window.WebSocket.CLOSING = OW.CLOSING; window.WebSocket.CLOSED = OW.CLOSED;
  }
  if(window.EventSource){
    var OE = window.EventSource;
    window.EventSource = function(u, o){ try{ u = fix(u); }catch(e){} return new OE(u, o); };
    window.EventSource.prototype = OE.prototype;
  }
  // 地址栏：SPA 用 pushState 改写的站内路径同样补上前缀
  ['pushState','replaceState'].forEach(function(k){
    var O = history[k];
    if(!O) return;
    history[k] = function(s, t, u){
      try{ if(typeof u === 'string') u = fix(u); }catch(e){}
      return O.call(this, s, t, u);
    };
  });
  if(location.assign){
    var OA = location.assign.bind(location);
    try{ location.assign = function(u){ return OA(fix(u)); }; }catch(e){}
  }
  if(location.replace){
    var OR = location.replace.bind(location);
    try{ location.replace = function(u){ return OR(fix(u)); }; }catch(e){}
  }
  // 修复 location.href 未被 hook 的问题：GitHub 等 SPA 框架常用 location.href = '...' 导航
  try{
    var _href = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
    if(_href && _href.set){
      Object.defineProperty(location, 'href', {
        get: function(){ return _href.get.call(this); },
        set: function(u){ _href.set.call(this, fix(String(u))); },
        enumerable: true,
        configurable: true
      });
    }
  }catch(e){}
  // 修复 window.open 未被 hook 的问题
  if(window.open){
    var _open = window.open.bind(window);
    window.open = function(u, t, o){ return _open(fix(String(u)), t, o); };
  }
  // 修复地址栏：监听 popstate 确保浏览器地址栏始终显示代理路径
  if(window.addEventListener){
    window.addEventListener('popstate', function(){
      try{
        var cur = String(location.href || '');
        if(cur && cur.indexOf(P) !== 0 && cur.indexOf(B) !== 0){
          var u = new URL(cur);
          if(u.pathname && u.pathname.indexOf(P) !== 0 && u.pathname.indexOf(B) !== 0){
            history.replaceState(null, '', P + u.pathname + u.search + u.hash);
          }
        }
      }catch(e){}
    });
  }
  // 导航：捕获阶段先于页面框架（React/turbo 等）拿到点击，
  // 只要链接映射到代理命名空间就整页跳转 —— 前端路由不认识 /p/ 前缀，会把导航吞掉
  document.addEventListener('click', function(e){
    if(e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var n = e.target;
    while(n && n.nodeType === 1){
      if(n.tagName === 'A'){
        if(n.hasAttribute && n.hasAttribute('download')) return;
        if(n.target && n.target !== '_self' && n.target !== '') return;
        var h = n.getAttribute('href');
        if(!h) return;
        var f = fix(h);
        if(f !== h) n.setAttribute('href', f);
        if(inNs(f)){ e.preventDefault(); e.stopPropagation(); location.href = f; }
        return;
      }
      n = n.parentNode;
    }
  }, true);
  // 修复：按钮元素（<button>等）的点击导航也需要处理
  // GitHub 等现代网站大量使用 <button> 元素进行导航，原代码只处理了 <a> 标签
  document.addEventListener('click', function(e){
    if(e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var n = e.target;
    while(n && n.nodeType === 1){
      if(n.tagName === 'BUTTON'){
        setTimeout(function(){
          try{
            var cur = String(location.href || '');
            if(cur && cur.indexOf(P) !== 0 && cur.indexOf(B) !== 0){
              var u = new URL(cur);
              if(u.pathname && u.pathname.indexOf(P) !== 0 && u.pathname.indexOf(B) !== 0){
                location.href = P + u.pathname + u.search + u.hash;
              }
            }
          }catch(e2){}
        }, 50);
        return;
      }
      n = n.parentNode;
    }
  }, true);
  // 表单提交：action 已在属性层修复，这里兜底处理脚本发起的 submit 到站内路径
  document.addEventListener('submit', function(e){
    var f = e.target;
    if(!f || !f.getAttribute) return;
    var a = f.getAttribute('action');
    if(!a) return;
    var nf = fix(a);
    if(nf !== a) f.setAttribute('action', nf);
  }, true);
  fixTree(document);
  setTimeout(function(){ fixTree(document); }, 300);
  setTimeout(function(){ fixTree(document); }, 1200);
  setTimeout(function(){ fixTree(document); }, 3000);
})();
<\/script>`;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, script + '\n</body>');
  return html + script;
}

/** 跨域资源通道前缀：/p/<id>/__x/<host>/<path> —— 承载任何非目标站域的资源 */

/**
 * 完全参考 cf-proxy-ex 的「服务端零重写 + 客户端全量转换」方案生成主文档：
 * 服务端只把原始 HTML base64 嵌入注入脚本，浏览器端解码 -> DOMParser 解析 ->
 * 统一把「属性 URL 与 script/style 内容里的 URL 字面量」转换为绝对代理 URL
 * （两边同一种形态，React 水合才不 mismatch）-> document.open/write/close 重建页面。
 * 重建后的文档末尾再注入运行时 hook（fetch/XHR/MutationObserver/导航拦截），
 * 兜底页面脚本运行时产生的真实 URL。
 */
function buildDocWritePage(html, site, sitePrefix, base, pageUrl) {
  const H = JSON.stringify(hostOf(site.host).toLowerCase());
  const BH = JSON.stringify(hostOf(base.host).toLowerCase());
  const P = JSON.stringify(sitePrefix);
  const B = JSON.stringify(base.prefix);
  const X = JSON.stringify(CROSS_PREFIX);
  const PAGE = JSON.stringify(pageUrl || `https://${hostOf(base.host)}/`);
  // 服务端 location 源码替换（照抄 cf-proxy-ex 1380-1384 行）：读 location 走 __apLocation（原始 URL），写自动代理化
  html = rewriteLocations(html);
  // BOM 移除（照抄 cf-proxy-ex 1409-1414 行）
  if (html.charCodeAt(0) === 0xFEFF) html = html.substring(1);
  const b64 = b64Encode(html);
  // 注入脚本 = 响应体（照抄 cf-proxy-ex：bd = inject，HTML 全部内联，浏览器端转换，防止 worker 资源超载）
  const inject = `<!DOCTYPE html>
<script>
(function(){
  var H=${H}, BH=${BH}, P=${P}, B=${B}, X=${X}, PAGE=${PAGE};
  function sub(h, s){ h=String(h||'').toLowerCase(); return !!h && h===String(s||'').toLowerCase(); }
  // ---------- changeURL：任意 URL -> 绝对代理 URL（照抄 cf-proxy-ex 对应实现，形态适配 /p/<id>/ 前缀） ----------
  function changeURL(raw){
    if(!raw || typeof raw!=='string') return raw;
    if(raw.charAt(0)==='#') return raw;
    if(/^(data|blob|javascript|mailto|tel|about|file|chrome|edge):/i.test(raw)) return raw;
    var u;
    try{
      if(/^https?:\\/\\//i.test(raw)) u = new URL(raw);
      else if(raw.indexOf('//')===0) u = new URL('https:'+raw);
      else u = new URL(raw, PAGE);
    }catch(e){ return raw; }
    var rest = u.pathname + u.search + u.hash;
    if(u.pathname === P || u.pathname.indexOf(P + '/') === 0 ||
       u.pathname === B || u.pathname.indexOf(B + '/') === 0) return location.origin + rest;
    if(sub(u.host, H) || sub(u.host, BH)) return location.origin + P + rest;
    return location.origin + P + X + u.host + rest;
  }
  // ---------- getOriginalUrl：代理 URL -> 原始 URL（照抄 cf-proxy-ex 对应实现） ----------
  function getOriginalUrl(raw){
    if(!raw || typeof raw!=='string') return raw;
    if(raw.indexOf('#')===0 || !/^https?:/i.test(raw)) return raw;
    try{
      var u = new URL(raw);
      if(!sub(u.hostname, location.hostname)) return raw;
      var p = u.pathname, q = u.search + u.hash;
      if(p === P || p.indexOf(P + '/') === 0) return 'https://' + H + (p.length > P.length ? p.slice(P.length) : '/') + q;
      if(p === B || p.indexOf(B + '/') === 0) return 'https://' + BH + (p.length > B.length ? p.slice(B.length) : '/') + q;
      if(p.indexOf(P + X) === 0){
        var r = p.slice((P + X).length);
        var i = r.indexOf('/');
        var host = i < 0 ? r : r.slice(0, i);
        var path = i < 0 ? '/' : r.slice(i);
        return 'https://' + host + path + q;
      }
    }catch(e){}
    return raw;
  }
  function changeSrcset(v){
    if(!v) return v;
    return v.split(',').map(function(s){ s = s.trim(); if(!s) return s;
      var seg = s.split(/\\s+/); seg[0] = changeURL(seg[0]); return seg.join(' '); }).join(', ');
  }
  function originalSrcset(v){
    if(!v) return v;
    return v.split(',').map(function(s){ s = s.trim(); if(!s) return s;
      var seg = s.split(/\\s+/); seg[0] = getOriginalUrl(seg[0]); return seg.join(' '); }).join(', ');
  }
  // ---------- ProxyLocation（照抄 cf-proxy-ex 355-484 行：get 原始 URL，set 写回代理） ----------
  var ORIG = null;
  try{ ORIG = new URL(PAGE); }catch(e){ try{ ORIG = new URL(location.href); }catch(e2){ ORIG = new URL('https://' + H + '/'); } }
  var __apLocation = {
    get href(){ return ORIG.href; }, set href(v){ try{ ORIG.href = v; }catch(e){} location.href = changeURL(v); },
    get protocol(){ return ORIG.protocol; }, set protocol(v){ try{ ORIG.protocol = v; }catch(e){} location.href = changeURL(ORIG.href); },
    get host(){ return ORIG.host; }, set host(v){ try{ ORIG.host = v; }catch(e){} location.href = changeURL(ORIG.href); },
    get hostname(){ return ORIG.hostname; }, set hostname(v){ try{ ORIG.hostname = v; }catch(e){} location.href = changeURL(ORIG.href); },
    get port(){ return ORIG.port; }, set port(v){ try{ ORIG.port = v; }catch(e){} location.href = changeURL(ORIG.href); },
    get pathname(){ return ORIG.pathname; }, set pathname(v){ try{ ORIG.pathname = v; }catch(e){} location.href = changeURL(ORIG.href); },
    get search(){ return ORIG.search; }, set search(v){ try{ ORIG.search = v; }catch(e){} location.href = changeURL(ORIG.href); },
    get hash(){ return ORIG.hash; }, set hash(v){ try{ ORIG.hash = v; }catch(e){} location.href = changeURL(ORIG.href); },
    get origin(){ return ORIG.origin; },
    reload: function(f){ location.reload(f); },
    replace: function(u){ location.replace(changeURL(u)); },
    assign: function(u){ location.assign(changeURL(u)); },
    toString: function(){ return ORIG.href; },
    valueOf: function(){ return ORIG.href; }
  };
  try{ window.__apLocation = __apLocation; document.__apLocation = __apLocation; }catch(e){}
  function syncOrig(){ try{ var o = getOriginalUrl(location.href); if(o && o.indexOf('http') === 0) ORIG = new URL(o); }catch(e){} }
  // ---------- elementPropertyInject：元素属性双向 hook（照抄 cf-proxy-ex 283-347 行） ----------
  var ATTRS = ['src','href','action','poster','data','formaction','srcset','data-src','data-srcset'];
  (function(){
    var OS = HTMLElement.prototype.setAttribute, OG = HTMLElement.prototype.getAttribute;
    HTMLElement.prototype.setAttribute = function(n, v){
      if(typeof n === 'string' && typeof v === 'string' && ATTRS.indexOf(n) >= 0){
        v = (n === 'srcset' || n === 'data-srcset') ? changeSrcset(v) : changeURL(v);
      }
      return OS.call(this, n, v);
    };
    HTMLElement.prototype.getAttribute = function(n){
      var v = OG.call(this, n);
      if(typeof n === 'string' && typeof v === 'string' && ATTRS.indexOf(n) >= 0){
        return (n === 'srcset' || n === 'data-srcset') ? originalSrcset(v) : getOriginalUrl(v);
      }
      return v;
    };
  })();
  var EL_PROPS = [
    [HTMLAnchorElement,'href'],[HTMLScriptElement,'src'],[HTMLImageElement,'src'],[HTMLLinkElement,'href'],
    [HTMLIFrameElement,'src'],[HTMLVideoElement,'src'],[HTMLAudioElement,'src'],[HTMLSourceElement,'src'],
    [HTMLObjectElement,'data'],[HTMLFormElement,'action'],[HTMLImageElement,'srcset'],[HTMLSourceElement,'srcset']
  ];
  for(var ei=0; ei<EL_PROPS.length; ei++){
    var C = EL_PROPS[ei][0], pn = EL_PROPS[ei][1];
    if(!C || !C.prototype) continue;
    var d = Object.getOwnPropertyDescriptor(C.prototype, pn);
    if(!d || !d.set) continue;
    (function(name, desc){
      Object.defineProperty(C.prototype, name, {
        get: function(){ var v = desc.get.call(this); return (name === 'srcset') ? originalSrcset(v) : getOriginalUrl(v); },
        set: function(v){ desc.set.call(this, (name === 'srcset') ? changeSrcset(v) : changeURL(v)); },
        configurable: true
      });
    })(pn, d);
  }
  // ---------- networkInject：fetch / XHR / WebSocket / EventSource（照抄 cf-proxy-ex 180-243 行） ----------
  if(window.fetch){
    var OF = window.fetch;
    window.fetch = function(u, o){
      try{
        if(typeof u === 'string') u = changeURL(u);
        else if(u && typeof u.url === 'string'){
          var f = changeURL(u.url);
          if(f !== u.url){ try{ u = new Request(f, u); }catch(e){ u = f; } }
        } else if(u && typeof u.href === 'string'){
          try{ u = new URL(changeURL(u.href)); }catch(e){}
        }
      }catch(e){}
      return OF.call(this, u, o);
    };
  }
  if(window.XMLHttpRequest){
    var OO = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(m, u){
      try{ u = changeURL(u); }catch(e){}
      var args = Array.prototype.slice.call(arguments);
      if(args.length > 1) args[1] = u;
      return OO.apply(this, args);
    };
  }
  if(window.WebSocket){
    var OW = window.WebSocket;
    window.WebSocket = function(u, p){
      try{ u = String(u||'').replace(/^ws/, 'http'); u = changeURL(u).replace(/^http/, 'ws'); }catch(e){}
      return new OW(u, p);
    };
    window.WebSocket.prototype = OW.prototype;
    window.WebSocket.CONNECTING = OW.CONNECTING; window.WebSocket.OPEN = OW.OPEN;
    window.WebSocket.CLOSING = OW.CLOSING; window.WebSocket.CLOSED = OW.CLOSED;
  }
  if(window.EventSource){
    var OE = window.EventSource;
    window.EventSource = function(u, o){ try{ u = changeURL(u); }catch(e){} return new OE(u, o); };
    window.EventSource.prototype = OE.prototype;
  }
  // ---------- historyInject / windowOpenInject / appendChildInject（照抄 cf-proxy-ex 246-277、531-596 行） ----------
  ['pushState','replaceState'].forEach(function(k){
    var O = history[k];
    if(!O) return;
    history[k] = function(s, t, u){
      try{ if(typeof u === 'string') u = changeURL(u); }catch(e){}
      var r = O.call(this, s, t, u);
      syncOrig();
      return r;
    };
  });
  try{
    var _open = window.open.bind(window);
    window.open = function(u, t, o){ return _open(changeURL(String(u)), t, o); };
  }catch(e){}
  try{
    var _app = Node.prototype.appendChild;
    Node.prototype.appendChild = function(child){
      try{
        if(child && child.nodeType === 1){
          if(child.src){ child.src = changeURL(child.src); }
          if(child.href){ child.href = changeURL(child.href); }
        }
      }catch(e){}
      return _app.call(this, child);
    };
  }catch(e){}
  if(location.assign){
    var OA = location.assign.bind(location);
    try{ location.assign = function(u){ var r = OA(changeURL(u)); syncOrig(); return r; }; }catch(e){}
  }
  if(location.replace){
    var OR = location.replace.bind(location);
    try{ location.replace = function(u){ var r = OR(changeURL(u)); syncOrig(); return r; }; }catch(e){}
  }
  // ---------- covToAbs / removeIntegrity / replaceContentPaths（照抄 cf-proxy-ex 616-624、898-914、880-898 行） ----------
  function removeIntegrityAttributesFromElement(el){
    try{ if(el.hasAttribute && el.hasAttribute('integrity')) el.removeAttribute('integrity'); }catch(e){}
  }
  function covToAbs(el){
    if(!el || el.nodeType !== 1) return;
    for(var i=0;i<ATTRS.length;i++){
      var a = ATTRS[i];
      if(!el.hasAttribute || !el.hasAttribute(a)) continue;
      var v = el.getAttribute(a);
      if(!v) continue;
      if(a === 'srcset' || a === 'data-srcset'){ var nv = changeSrcset(v); if(nv !== v) el.setAttribute(a, nv); }
      else { var f = changeURL(v); if(f !== v) el.setAttribute(a, f); }
    }
  }
  function replaceContentPaths(content){
    if(!content || content.indexOf('http') === -1) return content;
    var regex = new RegExp("(https?:\\/\\/[^\\s'\\"]+)", 'g');
    return content.replace(regex, function(match){
      if(match.indexOf('http://www.w3.org/') === 0 || match.indexOf('https://www.w3.org/') === 0) return match;
      var a = changeURL(match);
      return a === match ? match : a;
    });
  }
  function parseAndInsertDoc(htmlString){
    var parser = new DOMParser();
    var tempDoc = parser.parseFromString(htmlString, 'text/html');
    var allElements = tempDoc.querySelectorAll('*');
    for(var j=0; j<allElements.length; j++){
      var element = allElements[j];
      if(element.tagName === 'BASE'){ if(element.parentNode) element.parentNode.removeChild(element); continue; }
      covToAbs(element);
      removeIntegrityAttributesFromElement(element);
      if(element.tagName === 'SCRIPT' && element.textContent && !element.src){
        element.textContent = replaceContentPaths(element.textContent);
      }
      if(element.tagName === 'STYLE' && element.textContent){
        element.textContent = replaceContentPaths(element.textContent);
      }
    }
    var modifiedHtml = tempDoc.documentElement.outerHTML;
    var charset = modifiedHtml.match(/content="text\\/html;\\s*charset=[^"]*"/);
    if(charset != null && charset.length !== 0){
      modifiedHtml = modifiedHtml.replace(charset[0], "content='text/html;charset=utf-8'");
    }
    document.open();
    document.write('<!DOCTYPE html>' + modifiedHtml);
    document.close();
  }
  // ---------- obsPage / traverseAndConvert / loopAndConvertToAbs / covScript（照抄 cf-proxy-ex 604-624、782-787 行） ----------
  function traverseAndConvert(node){
    if(node && node.nodeType === 1){
      removeIntegrityAttributesFromElement(node);
      covToAbs(node);
      if(node.querySelectorAll){
        var cs = node.querySelectorAll('*');
        for(var i=0;i<cs.length;i++){ removeIntegrityAttributesFromElement(cs[i]); covToAbs(cs[i]); }
      }
    }
  }
  function obsPage(){
    new MutationObserver(function(mutations){
      for(var i=0;i<mutations.length;i++){
        var nn = mutations[i].addedNodes;
        for(var j=0;j<nn.length;j++) traverseAndConvert(nn[j]);
      }
    }).observe(document.body || document.documentElement, { attributes: true, childList: true, subtree: true });
  }
  function loopAndConvertToAbs(){
    var all = document.querySelectorAll('*');
    for(var i=0;i<all.length;i++){ removeIntegrityAttributesFromElement(all[i]); covToAbs(all[i]); }
  }
  function covScript(){
    var all = document.querySelectorAll('script:not([src]), style');
    for(var i=0;i<all.length;i++){
      var el = all[i];
      if(el.textContent){
        var c = replaceContentPaths(el.textContent);
        if(c !== el.textContent) el.textContent = c;
      }
    }
  }
  // ---------- 立即执行：解码 + 重建（照抄 cf-proxy-ex 1449-1471 行） ----------
  try{
    var bin = atob('${b64}');
    var bytes = new Uint8Array(bin.length);
    for(var i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
    parseAndInsertDoc(new TextDecoder().decode(bytes));
  }catch(e){
    try{ document.write('proxy init failed'); document.close(); }catch(e2){}
  }
  // ---------- load 后：全量转换 + 观察 + script/style 内容（照抄 cf-proxy-ex 782-787 行） ----------
  window.addEventListener('load', function(){
    loopAndConvertToAbs();
    obsPage();
    covScript();
  });
  // ---------- script 加载失败补救（照抄 cf-proxy-ex 796-820 行） ----------
  window.addEventListener('error', function(event){
    try{
      var element = event.target || event.srcElement;
      if(element && element.tagName === 'SCRIPT' && element.src){
        if(element.alreadyChanged) return;
        removeIntegrityAttributesFromElement(element);
        covToAbs(element);
        var newScript = document.createElement('script');
        newScript.src = element.src;
        newScript.async = element.async;
        newScript.defer = element.defer;
        newScript.alreadyChanged = true;
        document.head.appendChild(newScript);
      }
    }catch(e){}
  }, true);
})();
</script>`;
  return inject;
}

function rewriteLocations(s) {
  if (typeof s !== 'string' || !s || s.indexOf('location') === -1) return s;
  let out = s;
  out = out.split('window.location').join('window.__apLocation');
  out = out.split('document.location').join('document.__apLocation');
  out = out.split('location.href').join('__apLocation.href');
  out = out.split('location.replace(').join('__apLocation.replace(');
  out = out.split('location.assign(').join('__apLocation.assign(');
  return out;
}

/** Worker 侧 UTF-8 安全 base64（TextEncoder -> binary string -> btoa，分块避免栈溢出） */
function b64Encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export { injectHomeButton, injectLinkFix, buildDocWritePage, rewriteLocations };
