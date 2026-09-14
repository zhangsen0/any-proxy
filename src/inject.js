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
  const b64 = b64Encode(html);
  // 运行时 hook 脚本：完整参照 cf-proxy-ex 的「双向映射」注入栈 ——
  // 读取属性/location 时还原原始 URL（页面 JS/React 看到的与原站一致，水合才正常）；
  // 写入属性/发起请求时自动转代理 URL（资源始终走代理）。
  const hook = `<script>
(function(){
  var H=${H}, BH=${BH}, P=${P}, B=${B}, X=${X}, PAGE=${PAGE};
  function sub(h, s){ h=String(h||'').toLowerCase(); return !!h && h===String(s||'').toLowerCase(); }
  // ---------- 任意 URL -> 绝对代理 URL（changeURL） ----------
  function absUrl(raw){
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
  // ---------- 代理 URL -> 原始 URL（getOriginalUrl） ----------
  function getOriginal(raw){
    if(!raw || typeof raw!=='string') return raw;
    if(raw.indexOf('#')===0 || !/^https?:/i.test(raw)) return raw;
    try{
      var u = new URL(raw);
      if(!sub(u.hostname, location.hostname)) return raw;      // 非代理域：原样
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
  function absSrcset(v){
    if(!v) return v;
    return v.split(',').map(function(s){ s = s.trim(); if(!s) return s;
      var seg = s.split(/\\s+/); seg[0] = absUrl(seg[0]); return seg.join(' '); }).join(', ');
  }
  function origSrcset(v){
    if(!v) return v;
    return v.split(',').map(function(s){ s = s.trim(); if(!s) return s;
      var seg = s.split(/\\s+/); seg[0] = getOriginal(seg[0]); return seg.join(' '); }).join(', ');
  }
  // ---------- ProxyLocation：get 返回原始 URL，set 写回代理 ----------
  var ORIG = null;
  try{ ORIG = new URL(PAGE); }catch(e){ try{ ORIG = new URL(location.href); }catch(e2){ ORIG = new URL('https://' + H + '/'); } }
  var __apLocation = {
    get href(){ return ORIG.href; }, set href(v){ try{ ORIG.href = v; }catch(e){} location.href = absUrl(v); },
    get protocol(){ return ORIG.protocol; }, set protocol(v){ try{ ORIG.protocol = v; }catch(e){} location.href = absUrl(ORIG.href); },
    get host(){ return ORIG.host; }, set host(v){ try{ ORIG.host = v; }catch(e){} location.href = absUrl(ORIG.href); },
    get hostname(){ return ORIG.hostname; }, set hostname(v){ try{ ORIG.hostname = v; }catch(e){} location.href = absUrl(ORIG.href); },
    get port(){ return ORIG.port; }, set port(v){ try{ ORIG.port = v; }catch(e){} location.href = absUrl(ORIG.href); },
    get pathname(){ return ORIG.pathname; }, set pathname(v){ try{ ORIG.pathname = v; }catch(e){} location.href = absUrl(ORIG.href); },
    get search(){ return ORIG.search; }, set search(v){ try{ ORIG.search = v; }catch(e){} location.href = absUrl(ORIG.href); },
    get hash(){ return ORIG.hash; }, set hash(v){ try{ ORIG.hash = v; }catch(e){} location.href = absUrl(ORIG.href); },
    get origin(){ return ORIG.origin; },
    reload: function(f){ location.reload(f); },
    replace: function(u){ location.replace(absUrl(u)); },
    assign: function(u){ location.assign(absUrl(u)); },
    toString: function(){ return ORIG.href; },
    valueOf: function(){ return ORIG.href; }
  };
  try{ window.__apLocation = __apLocation; document.__apLocation = __apLocation; }catch(e){}
  function syncOrig(){ try{ var o = getOriginal(location.href); if(o && o.indexOf('http') === 0) ORIG = new URL(o); }catch(e){} }
  // ---------- 元素属性双向 hook（cf-proxy-ex elementPropertyInject） ----------
  var ATTRS = ['src','href','action','poster','data','formaction','srcset','data-src','data-srcset'];
  (function(){
    var OS = HTMLElement.prototype.setAttribute, OG = HTMLElement.prototype.getAttribute;
    HTMLElement.prototype.setAttribute = function(n, v){
      if(typeof n === 'string' && typeof v === 'string' && ATTRS.indexOf(n) >= 0){
        v = (n === 'srcset' || n === 'data-srcset') ? absSrcset(v) : absUrl(v);
      }
      return OS.call(this, n, v);
    };
    HTMLElement.prototype.getAttribute = function(n){
      var v = OG.call(this, n);
      if(typeof n === 'string' && typeof v === 'string' && ATTRS.indexOf(n) >= 0){
        return (n === 'srcset' || n === 'data-srcset') ? origSrcset(v) : getOriginal(v);
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
        get: function(){
          var v = desc.get.call(this);
          return (name === 'srcset') ? origSrcset(v) : getOriginal(v);
        },
        set: function(v){
          desc.set.call(this, (name === 'srcset') ? absSrcset(v) : absUrl(v));
        },
        configurable: true
      });
    })(pn, d);
  }
  // ---------- 网络层 ----------
  if(window.fetch){
    var OF = window.fetch;
    window.fetch = function(u, o){
      try{
        if(typeof u === 'string') u = absUrl(u);
        else if(u && typeof u.url === 'string'){
          var f = absUrl(u.url);
          if(f !== u.url){ try{ u = new Request(f, u); }catch(e){ u = f; } }
        } else if(u && typeof u.href === 'string'){
          try{ u = new URL(absUrl(u.href)); }catch(e){}
        }
      }catch(e){}
      return OF.call(this, u, o);
    };
  }
  if(window.XMLHttpRequest){
    var OO = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(m, u){
      try{ u = absUrl(u); }catch(e){}
      var args = Array.prototype.slice.call(arguments);
      if(args.length > 1) args[1] = u;
      return OO.apply(this, args);
    };
  }
  if(window.WebSocket){
    var OW = window.WebSocket;
    window.WebSocket = function(u, p){
      try{ u = String(u||'').replace(/^ws/, 'http'); u = absUrl(u).replace(/^http/, 'ws'); }catch(e){}
      if(!(this instanceof OW)) return new OW(u, p);
      return new OW(u, p);
    };
    window.WebSocket.prototype = OW.prototype;
    window.WebSocket.CONNECTING = OW.CONNECTING; window.WebSocket.OPEN = OW.OPEN;
    window.WebSocket.CLOSING = OW.CLOSING; window.WebSocket.CLOSED = OW.CLOSED;
  }
  if(window.EventSource){
    var OE = window.EventSource;
    window.EventSource = function(u, o){ try{ u = absUrl(u); }catch(e){} return new OE(u, o); };
    window.EventSource.prototype = OE.prototype;
  }
  // ---------- 历史 ----------
  ['pushState','replaceState'].forEach(function(k){
    var O = history[k];
    if(!O) return;
    history[k] = function(s, t, u){
      try{ if(typeof u === 'string') u = absUrl(u); }catch(e){}
      var r = O.call(this, s, t, u);
      syncOrig();
      return r;
    };
  });
  if(location.assign){
    var OA = location.assign.bind(location);
    try{ location.assign = function(u){ var r = OA(absUrl(u)); syncOrig(); return r; }; }catch(e){}
  }
  if(location.replace){
    var OR = location.replace.bind(location);
    try{ location.replace = function(u){ var r = OR(absUrl(u)); syncOrig(); return r; }; }catch(e){}
  }
  try{
    var _href = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
    if(_href && _href.set){
      Object.defineProperty(location, 'href', {
        get: function(){ return _href.get.call(this); },
        set: function(u){ var a = absUrl(String(u)); if(a !== u) _href.set.call(this, a); else _href.set.call(this, u); syncOrig(); },
        enumerable: true, configurable: true
      });
    }
  }catch(e){}
  // ---------- window.open / appendChild ----------
  if(window.open){
    var _open = window.open.bind(window);
    window.open = function(u, t, o){ return _open(absUrl(String(u)), t, o); };
  }
  try{
    var _app = Node.prototype.appendChild;
    Node.prototype.appendChild = function(child){
      try{
        if(child && child.nodeType === 1){
          if(child.src){ child.src = absUrl(child.src); }
          if(child.href){ child.href = absUrl(child.href); }
        }
      }catch(e){}
      return _app.call(this, child);
    };
  }catch(e){}
  // ---------- 新 DOM 观察（innerHTML/解析插入的属性不走 setAttribute hook） ----------
  function fixEl(el){
    if(!el || el.nodeType!==1 || el._apf) return;
    el._apf = 1;
    if(el.tagName === 'BASE'){ if(el.parentNode) el.parentNode.removeChild(el); return; }
    for(var i=0;i<ATTRS.length;i++){
      var a = ATTRS[i];
      if(!el.hasAttribute || !el.hasAttribute(a)) continue;
      var v = el.getAttribute(a);
      if(!v) continue;
      if(a === 'srcset' || a === 'data-srcset'){
        var nv = absSrcset(v);
        if(nv !== v) el.setAttribute(a, nv);
      } else {
        var f = absUrl(v);
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
  if(window.MutationObserver){
    new MutationObserver(function(ms){
      for(var i=0;i<ms.length;i++){
        var nn = ms[i].addedNodes;
        for(var j=0;j<nn.length;j++) fixTree(nn[j]);
        if(ms[i].type === 'attributes' && ms[i].target && ms[i].target.nodeType === 1){
          ms[i].target._apf = 0; fixEl(ms[i].target);
        }
      }
    }).observe(document.documentElement, {subtree:true, childList:true, attributes:true, attributeFilter:ATTRS});
  }
  // ---------- 导航兜底 ----------
  document.addEventListener('click', function(e){
    if(e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var n = e.target;
    while(n && n.nodeType === 1){
      if(n.tagName === 'A'){
        if(n.hasAttribute && n.hasAttribute('download')) return;
        if(n.target && n.target !== '_self' && n.target !== '') return;
        var h = n.getAttribute('href');
        if(!h) return;
        var f = absUrl(h);
        if(f !== h) n.setAttribute('href', f);
        try{
          var up = new URL(f);
          if(up.pathname === P || up.pathname.indexOf(P + '/') === 0){
            e.preventDefault(); e.stopPropagation(); location.href = f;
          }
        }catch(e2){}
        return;
      }
      n = n.parentNode;
    }
  }, true);
  document.addEventListener('submit', function(e){
    var f = e.target;
    if(!f || !f.getAttribute) return;
    var a = f.getAttribute('action');
    if(!a) return;
    var nf = absUrl(a);
    if(nf !== a) f.setAttribute('action', nf);
  }, true);
  fixTree(document);
  setTimeout(function(){ fixTree(document); }, 300);
  setTimeout(function(){ fixTree(document); }, 1200);
  setTimeout(function(){ fixTree(document); }, 3000);
})();
</script>`;
  // INIT 脚本：解码 -> DOMParser -> 属性转代理 + script/style 字面量转代理（含 location 源码替换）-> 重建
  const init = `<script>
(function(){
  var H=${H}, BH=${BH}, P=${P}, B=${B}, X=${X}, PAGE=${PAGE};
  function sub(h, s){ h=String(h||'').toLowerCase(); return !!h && h===String(s||'').toLowerCase(); }
  function absUrl(raw){
    if(!raw || typeof raw!=='string') return raw;
    if(raw.charAt(0)==='#') return raw;
    if(/^(data|blob|javascript|mailto|tel|about|file):/i.test(raw)) return raw;
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
  function fixSrcset(v){
    if(!v) return v;
    return v.split(',').map(function(s){ s = s.trim(); if(!s) return s;
      var seg = s.split(/\\s+/); seg[0] = absUrl(seg[0]); return seg.join(' '); }).join(', ');
  }
  function convContent(s){
    if(!s) return s;
    // location 源码替换（cf-proxy-ex 做法）：读 location 走 __apLocation（原始 URL），写自动代理化
    s = s.split('window.location').join('window.__apLocation');
    s = s.split('document.location').join('document.__apLocation');
    s = s.split('location.href').join('__apLocation.href');
    s = s.split('location.replace(').join('__apLocation.replace(');
    s = s.split('location.assign(').join('__apLocation.assign(');
    if(s.indexOf('http') === -1) return s;
    return s.replace(/(["'])(https?:\\/\\/[^"'\\s][^"']*)\\1/g, function(m, q, u){
      var a = absUrl(u); return a === u ? m : q + a + q;
    });
  }
  try{
    var bin = atob('${b64}');
    var bytes = new Uint8Array(bin.length);
    for(var i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
    var html = new TextDecoder().decode(bytes);
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var all = doc.querySelectorAll('*');
    for(var j=0;j<all.length;j++){
      var el = all[j];
      if(el.tagName === 'BASE'){ if(el.parentNode) el.parentNode.removeChild(el); continue; }
      var attrs = ['href','src','action','poster','data','formaction','data-src','data-srcset'];
      for(var k=0;k<attrs.length;k++){
        var an = attrs[k];
        if(!el.hasAttribute(an)) continue;
        var v = el.getAttribute(an);
        if(!v) continue;
        if(an === 'srcset' || an === 'data-srcset'){ var nv = fixSrcset(v); if(nv !== v) el.setAttribute(an, nv); }
        else { var f = absUrl(v); if(f !== v) el.setAttribute(an, f); }
      }
      if(el.hasAttribute('integrity')) el.removeAttribute('integrity');
      if(el.tagName === 'SCRIPT' && !el.src && el.textContent){
        var c = convContent(el.textContent);
        if(c !== el.textContent) el.textContent = c;
      }
      if(el.tagName === 'STYLE' && el.textContent){
        var sc = el.textContent.replace(/url\((['"]?)(https?:\\/\\/[^)'"]+|\\/\\/[^)'"]+)\\1\)/g, function(m, q, u){
          var a = absUrl(u); return a === u ? m : 'url(' + q + a + q + ')';
        });
        if(sc !== el.textContent) el.textContent = sc;
      }
    }
    var out = '<!DOCTYPE html>' + doc.documentElement.outerHTML;
    var HOOK = ${JSON.stringify(hook).replace(/<\/script>/gi, '<\\/script>')};
    if(/<\\/body>/i.test(out)) out = out.replace(/<\\/body>/i, HOOK + '</body>');
    else out += HOOK;
    document.open();
    document.write(out);
    document.close();
  }catch(e){
    document.write(html || '<!-- proxy init failed -->');
    document.close();
  }
})();
</script>`;
  return '<!DOCTYPE html>' + init;
}

/**
 * 外部 JS 文件的 location 源码替换（cf-proxy-ex 做法）：
 * 把 window.location / document.location / location.href 等读取点改为 __apLocation
 * （运行时注入的 ProxyLocation：读原始 URL、写自动代理化），不改任何 URL 字面量。
 */
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
