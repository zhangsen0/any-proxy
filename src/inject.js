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
  // 服务端：照抄 cf-proxy-ex 1380-1384（location 关键字替换为 __location__yproxy__）
  html = rewriteLocations(html);
  // BOM 移除（照抄 cf-proxy-ex 1409-1414）
  if (html.charCodeAt(0) === 0xFEFF) html = html.substring(1);
  // 原始 HTML 字节数组内联（照抄 cf-proxy-ex 1449-1452）
  const arr = Array.from(new TextEncoder().encode(html)).join(',');
  // cf-proxy-ex 注入脚本原文（原样复制：httpRequestInjection + htmlCovPathInject + 执行段）
  const CORE = `
//---***========================================***---information---***========================================***---
var nowURL = new URL(window.location.href);
var proxy_host = nowURL.host; //代理的host - proxy.com
var proxy_protocol = nowURL.protocol; //代理的protocol
var proxy_host_with_schema = proxy_protocol + "//" + proxy_host + "/"; //代理前缀 https://proxy.com/




// 每次都要动态计算。比如某个网站把 #1 -> #2 然后 JS 调用。如果静态计算的话就还是会是 # 1

// var original_website_url_str = window.location.href.substring(proxy_host_with_schema.length); //被代理的【完整】地址 如：https://example.com/1?q#1
// var original_website_url = new URL(original_website_url_str);

// var original_website_host = original_website_url_str.substring(original_website_url_str.indexOf("://") + "://".length);
// original_website_host = original_website_host.split('/')[0]; //被代理的Host proxied_website.com

// var original_website_host_with_schema = original_website_url_str.substring(0, original_website_url_str.indexOf("://")) + "://" + original_website_host + "/"; //加上https的被代理的host， https://proxied_website.com/


//被代理的【完整】地址 如：https://example.com/1?q#1
// ===== 兼容层：original_website_* 动态解析（适配 /p/<id>/ 前缀形态）=====
Object.defineProperty(window, 'original_website_url_str', {
    get: function() { return getOriginalUrl(window.location.href); }
});
Object.defineProperty(window, 'original_website_url', {
    get: function() { return new URL(original_website_url_str); }
});
Object.defineProperty(window, 'original_website_host', {
    get: function() {
        var h = original_website_url_str.substring(original_website_url_str.indexOf("://") + "://".length);
        return h.split('/')[0];
    }
});
Object.defineProperty(window, 'original_website_host_with_schema', {
    get: function() {
        return original_website_url_str.substring(0, original_website_url_str.indexOf("://")) + "://" + original_website_host + "/";
    }
});

function changeURL(relativePath) {
    if (relativePath == null) return null;

    let relativePath_str = "";
    if (relativePath instanceof URL) {
        relativePath_str = relativePath.href;
    } else {
        relativePath_str = relativePath.toString();
    }


    try {
        if (relativePath_str.startsWith("data:") || relativePath_str.startsWith("mailto:") || relativePath_str.startsWith("javascript:") || relativePath_str.startsWith("chrome") || relativePath_str.startsWith("edge")) return relativePath_str;
    } catch {
        console.log("Change URL Error **************************************:");
        console.log(relativePath_str);
        console.log(typeof relativePath_str);

        return relativePath_str;
    }


    // for example, blob:https://example.com/, we need to remove blob and add it back later
    var pathAfterAdd = "";

    if (relativePath_str.startsWith("blob:")) {
        pathAfterAdd = "blob:";
        relativePath_str = relativePath_str.substring("blob:".length);
    }


    try {
        // 把relativePath去除掉当前代理的地址 https://proxy.com/ ， relative path成为 被代理的（相对）地址，target_website.com/path
        let startWithLs = [proxy_host_with_schema, proxy_host + "/", proxy_host]

        startWithLs.forEach(x => {
            if (relativePath_str.startsWith(x)) relativePath_str = relativePath_str.substring(x.length);
        });
        // 如果是 /https://proxy.com/ 也去掉
        startWithLs.forEach(x => {
            x = "/" + x;
            if (relativePath_str.startsWith(x)) relativePath_str = relativePath_str.substring(x.length);
        });


        // 修复： Original: /https://www.google.com/recaptcha/enterprise/reload?k=6LfwuyUTAAAAAOAmoS0fdqijC2PbbdH4kjq62Y1b
        let enhancedStartRm = [original_website_host_with_schema.substring(0, original_website_host_with_schema.length - 1), original_website_host]
        // substring 去除掉末尾的 /
        // 原因：relativePath_str 在去掉 /https://www.google.com/ 后变成了 recaptcha/enterprise/reload?k=...（没有前导 /）。
        enhancedStartRm.forEach(x => {
            x = "/" + x;
            if (relativePath_str.startsWith(x)) relativePath_str = relativePath_str.substring(x.length);
            // console.log("Replacing: " + x + "   The replaced: " + relativePath_str);
        });
    } catch {
        //ignore
    }
    try {
        // console.log("relativePath_str: " + relativePath_str + "; original_website_url_str: " + original_website_url_str);
        var absolutePath = new URL(relativePath_str, original_website_url_str).href; //获取绝对路径
        absolutePath = absolutePath.replaceAll(window.location.href, original_website_url_str); //可能是参数里面带了当前的链接，需要还原原来的链接防止403
        absolutePath = absolutePath.replaceAll(encodeURI(window.location.href), encodeURI(original_website_url_str));
        absolutePath = absolutePath.replaceAll(encodeURIComponent(window.location.href), encodeURIComponent(original_website_url_str));

        absolutePath = absolutePath.replaceAll(proxy_host, original_website_host);
        absolutePath = absolutePath.replaceAll(encodeURI(proxy_host), encodeURI(original_website_host));
        absolutePath = absolutePath.replaceAll(encodeURIComponent(proxy_host), encodeURIComponent(original_website_host));

        absolutePath = proxy_host_with_schema + absolutePath;



        absolutePath = pathAfterAdd + absolutePath;




        return absolutePath;
    } catch (e) {
        console.log("Exception occured: " + e.message + original_website_url_str + "   " + relativePath_str);
        return relativePath_str;
    }
}


// change from https://proxy.com/https://target_website.com/a to https://target_website.com/a
function getOriginalUrl(url) {
    if (url == null) return null;
    if (url.startsWith(proxy_host_with_schema)) return url.substring(proxy_host_with_schema.length);
    return url;
}




//---***========================================***---注入网络---***========================================***---
function networkInject() {
    //inject network request
    var originalOpen = XMLHttpRequest.prototype.open;
    var originalFetch = window.fetch;
    XMLHttpRequest.prototype.open = function (method, url, async, user, password) {

        console.log("Original: " + url);

        url = changeURL(url);

        console.log("R:" + url);
        return originalOpen.apply(this, arguments);
    };

    window.fetch = function (input, init) {
        var url;
        if (typeof input === 'string') {
            url = input;
        } else if (input instanceof Request) {
            url = input.url;
        } else {
            url = input;
        }



        url = changeURL(url);



        console.log("R:" + url);
        if (typeof input === 'string') {
            return originalFetch(url, init);
        } else {
            const newRequest = new Request(url, input);
            return originalFetch(newRequest, init);
        }
    };

    console.log("NETWORK REQUEST METHOD INJECTED");
}


//---***========================================***---注入window.open---***========================================***---
function windowOpenInject() {
    const originalOpen = window.open;

    // Override window.open function
    window.open = function (url, name, specs) {
        let modifiedUrl = changeURL(url);
        return originalOpen.call(window, modifiedUrl, name, specs);
    };

    console.log("WINDOW OPEN INJECTED");
}


//---***========================================***---注入append元素---***========================================***---
function appendChildInject() {
    const originalAppendChild = Node.prototype.appendChild;
    Node.prototype.appendChild = function (child) {
        try {
            if (child.src) {
                child.src = changeURL(child.src);
            }
            if (child.href) {
                child.href = changeURL(child.href);
            }
        } catch {
            //ignore
        }
        return originalAppendChild.call(this, child);
    };
    console.log("APPEND CHILD INJECTED");
}




//---***========================================***---注入元素的src和href---***========================================***---
function elementPropertyInject() {
    const originalSetAttribute = HTMLElement.prototype.setAttribute;
    HTMLElement.prototype.setAttribute = function (name, value) {
        if (name == "src" || name == "href" || name == "action") {
            value = changeURL(value);
        }
        originalSetAttribute.call(this, name, value);
    };


    const originalGetAttribute = HTMLElement.prototype.getAttribute;
    HTMLElement.prototype.getAttribute = function (name) {
        const val = originalGetAttribute.call(this, name);
        if (name == "src" || name == "href" || name == "action") {
            return getOriginalUrl(val);
        }
        return val;
    };



    console.log("ELEMENT PROPERTY (get/set attribute) INJECTED");



    // -------------------------------------


    //ChatGPT + personal modify
    const setList = [
        [HTMLAnchorElement, "href"],
        [HTMLScriptElement, "src"],
        [HTMLImageElement, "src"],
        // [HTMLImageElement, "srcset"], // 注意 srcset 是特殊格式，可以先只处理 src
        [HTMLLinkElement, "href"],
        [HTMLIFrameElement, "src"],
        [HTMLVideoElement, "src"],
        [HTMLAudioElement, "src"],
        [HTMLSourceElement, "src"],
        // [HTMLSourceElement, "srcset"],
        [HTMLObjectElement, "data"],
        [HTMLFormElement, "action"],
    ];

    for (const [whichElement, whichProperty] of setList) {
        if (!whichElement || !whichElement.prototype) continue;
        const descriptor = Object.getOwnPropertyDescriptor(whichElement.prototype, whichProperty);
        if (!descriptor) continue;

        Object.defineProperty(whichElement.prototype, whichProperty, {
            get: function () {
                const real = descriptor.get.call(this);
                return getOriginalUrl(real);
            },
            set: function (val) {
                descriptor.set.call(this, changeURL(val));
            },
            configurable: true,
        });

        console.log("Hooked " + whichElement.name + " " + whichProperty);
    }



    console.log("ELEMENT PROPERTY (src / href) INJECTED");
}




//---***========================================***---注入location---***========================================***---
class ProxyLocation {
    constructor(originalLocation) {
        this.originalLocation = originalLocation;
    }

    // 方法：重新加载页面
    reload(forcedReload) {
        this.originalLocation.reload(forcedReload);
    }

    // 方法：替换当前页面
    replace(url) {
        this.originalLocation.replace(changeURL(url));
    }

    // 方法：分配一个新的 URL
    assign(url) {
        this.originalLocation.assign(changeURL(url));
    }

    // 属性：获取和设置 href
    get href() {
        return original_website_url_str;
    }

    set href(url) {
        this.originalLocation.href = changeURL(url);
    }

    // 属性：获取和设置 protocol
    get protocol() {
        return original_website_url.protocol;
    }

    set protocol(value) {
        original_website_url.protocol = value;
        this.originalLocation.href = proxy_host_with_schema + original_website_url.href;
    }

    // 属性：获取和设置 host
    get host() {
        return original_website_url.host;
    }

    set host(value) {
        original_website_url.host = value;
        this.originalLocation.href = proxy_host_with_schema + original_website_url.href;
    }

    // 属性：获取和设置 hostname
    get hostname() {
        return original_website_url.hostname;
    }

    set hostname(value) {
        original_website_url.hostname = value;
        this.originalLocation.href = proxy_host_with_schema + original_website_url.href;
    }

    // 属性：获取和设置 port
    get port() {
        return original_website_url.port;
    }

    set port(value) {
        original_website_url.port = value;
        this.originalLocation.href = proxy_host_with_schema + original_website_url.href;
    }

    // 属性：获取和设置 pathname
    get pathname() {
        return original_website_url.pathname;
    }

    set pathname(value) {
        original_website_url.pathname = value;
        this.originalLocation.href = proxy_host_with_schema + original_website_url.href;
    }

    // 属性：获取和设置 search
    get search() {
        return original_website_url.search;
    }

    set search(value) {
        original_website_url.search = value;
        this.originalLocation.href = proxy_host_with_schema + original_website_url.href;
    }

    // 属性：获取和设置 hash
    get hash() {
        return original_website_url.hash;
    }

    set hash(value) {
        original_website_url.hash = value;
        this.originalLocation.href = proxy_host_with_schema + original_website_url.href;
    }

    // 属性：获取 origin
    get origin() {
        return original_website_url.origin;
    }

    toString() {
        return this.originalLocation.href;
    }
}



function documentLocationInject() {
    Object.defineProperty(document, 'URL', {
        get: function () {
            return original_website_url_str;
        },
        set: function (url) {
            document.URL = changeURL(url);
        }
    });

    Object.defineProperty(document, '__location__yproxy__', {
        get: function () {
            return new ProxyLocation(window.location);
        },
        set: function (url) {
            window.location.href = changeURL(url);
        }
    });
    console.log("LOCATION INJECTED");
}



function windowLocationInject() {

    Object.defineProperty(window, '__location__yproxy__', {
        get: function () {
            return new ProxyLocation(window.location);
        },
        set: function (url) {
            window.location.href = changeURL(url);
        }
    });

    console.log("WINDOW LOCATION INJECTED");
}

function safeFallbackLocationInject() {

    Object.defineProperty(Object.prototype, '__location__yproxy__', {
        get: function () {
            console.log("*** GET SAFE FALLBACK CALLED ***");
            // window / document 有 own property，会优先命中各自 getter，不会走到这里
            return this == null ? undefined : this.location;
        },
        set: function (value) {
            console.log("*** SET SAFE FALLBACK CALLED ***");
            if (this != null) this.location = value;
        },
        configurable: true,
        enumerable: false   // 不能污染 for-in / Object.keys / JSON.stringify
    });
    console.log("OBJECT PROTOTYPE LOCATION FALLBACK INJECTED");

}










//---***========================================***---注入历史---***========================================***---
function historyInject() {
    const originalPushState = History.prototype.pushState;
    const originalReplaceState = History.prototype.replaceState;
    const originalBack = History.prototype.back;
    const originalForward = History.prototype.forward;
    const originalGo = History.prototype.go;

    History.prototype.pushState = function (state, title, url) {
        if (!url) return; //x.com 会有一次undefined


        if (url.startsWith("/" + original_website_url.href)) url = url.substring(("/" + original_website_url.href).length); // https://example.com/
        if (url.startsWith("/" + original_website_url.href.substring(0, original_website_url.href.length - 1))) url = url.substring(("/" + original_website_url.href).length - 1); // https://example.com (没有/在最后)


        var u = changeURL(url);
        return originalPushState.apply(this, [state, title, u]);
    };

    History.prototype.replaceState = function (state, title, url) {
        console.log("History url started: " + url);
        if (!url) return; //x.com 会有一次undefined

        // console.log(Object.prototype.toString.call(url)); // [object URL] or string


        let url_str = url.toString(); // 如果是 string，那么不会报错，如果是 [object URL] 会解决报错


        //这是给duckduckgo专门的补丁，可能是window.location字样做了加密，导致服务器无法替换。
        //正常链接它要设置的history是/，改为proxy之后变为/https://duckduckgo.com。
        //但是这种解决方案并没有从“根源”上解决问题

        if (url_str.startsWith("/" + original_website_url.href)) url_str = url_str.substring(("/" + original_website_url.href).length); // https://example.com/
        if (url_str.startsWith("/" + original_website_url.href.substring(0, original_website_url.href.length - 1))) url_str = url_str.substring(("/" + original_website_url.href).length - 1); // https://example.com (没有/在最后)


        //给ipinfo.io的补丁：历史会设置一个https:/ipinfo.io，可能是他们获取了href，然后想设置根目录
        // *** 这里不需要 replaceAll，因为只是第一个需要替换 ***
        if (url_str.startsWith("/" + original_website_url.href.replace("://", ":/"))) url_str = url_str.substring(("/" + original_website_url.href.replace("://", ":/")).length); // https://example.com/
        if (url_str.startsWith("/" + original_website_url.href.substring(0, original_website_url.href.length - 1).replace("://", ":/"))) url_str = url_str.substring(("/" + original_website_url.href).replace("://", ":/").length - 1); // https://example.com (没有/在最后)



        var u = changeURL(url_str);

        console.log("History url changed: " + u);

        return originalReplaceState.apply(this, [state, title, u]);
    };

    History.prototype.back = function () {
        return originalBack.apply(this);
    };

    History.prototype.forward = function () {
        return originalForward.apply(this);
    };

    History.prototype.go = function (delta) {
        return originalGo.apply(this, [delta]);
    };

    console.log("HISTORY INJECTED");
}






//---***========================================***---Hook观察界面---***========================================***---
function obsPage() {
    var yProxyObserver = new MutationObserver(function (mutations) {
        mutations.forEach(function (mutation) {
            traverseAndConvert(mutation);
        });
    });
    var config = { attributes: true, childList: true, subtree: true };
    yProxyObserver.observe(document.body, config);

    console.log("OBSERVING THE WEBPAGE...");
}

function traverseAndConvert(node) {
    if (node instanceof HTMLElement) {
        removeIntegrityAttributesFromElement(node);
        covToAbs(node);
        node.querySelectorAll('*').forEach(function (child) {
            removeIntegrityAttributesFromElement(child);
            covToAbs(child);
        });
    }
}


// ************************************************************************
// ************************************************************************
// Problem: img can also have srcset
// https://developer.mozilla.org/en-US/docs/Web/HTML/Guides/Responsive_images
// and link secret
// https://developer.mozilla.org/en-US/docs/Web/API/HTMLLinkElement/imageSrcset
// ************************************************************************
// ************************************************************************

function covToAbs(element) {
    if (!(element instanceof HTMLElement)) return;


    if (element.hasAttribute("href")) {
        relativePath = element.getAttribute("href");
        try {
            var absolutePath = changeURL(relativePath);
            element.setAttribute("href", absolutePath);
        } catch (e) {
            console.log("Exception occured: " + e.message + original_website_url_str + "   " + relativePath);
            console.log(element);
        }
    }


    if (element.hasAttribute("src")) {
        relativePath = element.getAttribute("src");
        try {
            var absolutePath = changeURL(relativePath);
            element.setAttribute("src", absolutePath);
        } catch (e) {
            console.log("Exception occured: " + e.message + original_website_url_str + "   " + relativePath);
            console.log(element);
        }
    }


    if (element.tagName === "FORM" && element.hasAttribute("action")) {
        relativePath = element.getAttribute("action");
        try {
            var absolutePath = changeURL(relativePath);
            element.setAttribute("action", absolutePath);
        } catch (e) {
            console.log("Exception occured: " + e.message + original_website_url_str + "   " + relativePath);
            console.log(element);
        }
    }


    if (element.tagName === "SOURCE" && element.hasAttribute("srcset")) {
        relativePath = element.getAttribute("srcset");
        try {
            var absolutePath = changeURL(relativePath);
            element.setAttribute("srcset", absolutePath);
        } catch (e) {
            console.log("Exception occured: " + e.message + original_website_url_str + "   " + relativePath);
            console.log(element);
        }
    }


    // 视频的封面图
    if ((element.tagName === "VIDEO" || element.tagName === "AUDIO") && element.hasAttribute("poster")) {
        relativePath = element.getAttribute("poster");
        try {
            var absolutePath = changeURL(relativePath);
            element.setAttribute("poster", absolutePath);
        } catch (e) {
            console.log("Exception occured: " + e.message);
        }
    }



    if (element.tagName === "OBJECT" && element.hasAttribute("data")) {
        relativePath = element.getAttribute("data");
        try {
            var absolutePath = changeURL(relativePath);
            element.setAttribute("data", absolutePath);
        } catch (e) {
            console.log("Exception occured: " + e.message);
        }
    }





}


function removeIntegrityAttributesFromElement(element) {
    if (element.hasAttribute('integrity')) {
        element.removeAttribute('integrity');
    }
}
//---***========================================***---Hook观察界面里面要用到的func---***========================================***---
function loopAndConvertToAbs() {
    for (var ele of document.querySelectorAll('*')) {
        removeIntegrityAttributesFromElement(ele);
        covToAbs(ele);
    }
    console.log("LOOPED EVERY ELEMENT");
}

function covScript() { //由于observer经过测试不会hook添加的script标签，也可能是我测试有问题？
    var scripts = document.getElementsByTagName('script');
    for (var i = 0; i < scripts.length; i++) {
        covToAbs(scripts[i]);
    }
    setTimeout(covScript, 3000);
}




























//---***========================================***---操作---***========================================***---
networkInject();
windowOpenInject();
elementPropertyInject();
appendChildInject();
documentLocationInject();
windowLocationInject();
safeFallbackLocationInject();
historyInject();




//---***========================================***---在window.load之后的操作---***========================================***---
window.addEventListener('load', () => {
    loopAndConvertToAbs();
    console.log("CONVERTING SCRIPT PATH");
    obsPage();
    covScript();
});
console.log("WINDOW ONLOAD EVENT ADDED");





//---***========================================***---在window.error的时候---***========================================***---

window.addEventListener('error', event => {
    var element = event.target || event.srcElement;
    if (element.tagName === 'SCRIPT') {
        console.log("Found problematic script:", element);
        if (element.alreadyChanged) {
            console.log("this script has already been injected, ignoring this problematic script...");
            return;
        }
        // 调用 covToAbs 函数
        removeIntegrityAttributesFromElement(element);
        covToAbs(element);

        // 创建新的 script 元素
        var newScript = document.createElement("script");
        newScript.src = element.src;
        newScript.async = element.async; // 保留原有的 async 属性
        newScript.defer = element.defer; // 保留原有的 defer 属性
        newScript.alreadyChanged = true;

        // 添加新的 script 元素到 document
        document.head.appendChild(newScript);

        console.log("New script added:", newScript);
    }
}, true);
console.log("WINDOW CORS ERROR EVENT ADDED");



`;
  const COMPAT = `
// ===== 兼容层：覆盖 changeURL/getOriginalUrl（cf-proxy-ex 原文在上方保留，同名函数覆盖生效；适配 /p/<id>/ 多站点形态）=====
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
`;
  const HTML = `function parseAndInsertDoc(htmlString) {
  // First, modify the HTML string to update all URLs and remove integrity
  const parser = new DOMParser();
  const tempDoc = parser.parseFromString(htmlString, 'text/html');
  
  // Process all elements in the temporary document
  const allElements = tempDoc.querySelectorAll('*');

  allElements.forEach(element => {
    covToAbs(element);
    removeIntegrityAttributesFromElement(element);



    if (element.tagName === 'SCRIPT') {
      if (element.textContent && !element.src) {
          element.textContent = replaceContentPaths(element.textContent);
      }
    }
  
    if (element.tagName === 'STYLE') {
      if (element.textContent) {
          element.textContent = replaceContentPaths(element.textContent);
      }
    }
  });

  
  // Get the modified HTML string
  let modifiedHtml = tempDoc.documentElement.outerHTML;


  let charset = modifiedHtml.match(/content="text\\/html;\\s*charset=[^"]*"/);
  console.log(charset);
  if(charset != null && charset.length !== 0){
    modifiedHtml = modifiedHtml.replace(charset[0], "content='text/html;charset=utf-8'");
    // only replace the first here
  }

  
  // Now use document.open/write/close to replace the entire document
  // This preserves the natural script execution order
  document.open();
  document.write('<!DOCTYPE html>' + modifiedHtml);
  document.close();
}




function replaceContentPaths(content){
  let regex = new RegExp(\`(https?:\\\\/\\\\/[^\s'"]+)\`, 'g');
  // 这里写四个 \ 是因为 Server side 的文本也会把它当成转义符
  content = content.replaceAll(regex, (match) => {
    if (match.startsWith("http://www.w3.org/") || match.startsWith("https://www.w3.org/")) return match; // w3范式
    
    var a = changeURL(match);
      return a === match ? match : a;
  });



  return content;


}
`;
  const inject = '<!DOCTYPE html>\n<script>\n(function(){\n' +
    '  var H=' + H + ', BH=' + BH + ', P=' + P + ', B=' + B + ', X=' + X + ', PAGE=' + PAGE + ';\n' +
    '  function sub(h, s){ h=String(h||\'\').toLowerCase(); return !!h && h===String(s||\'\').toLowerCase(); }\n' +
    CORE + '\n' + COMPAT + '\n' + HTML + '\n' +
    '  (function(){ try{ var bytes = new Uint8Array([' + arr + ']); parseAndInsertDoc(new TextDecoder().decode(bytes)); }catch(e){ try{ document.write(\'proxy init failed\'); document.close(); }catch(e2){} } })();\n' +
    '})();\n</script>';
  return inject;
}

function rewriteLocations(s) {
  if (typeof s !== 'string' || !s || s.indexOf('location') === -1) return s;
  let out = s;
  // 替换名与 cf-proxy-ex 一致：__location__yproxy__（注入脚本 windowLocationInject 同名注册）
  out = out.split('window.location').join('window.__location__yproxy__');
  out = out.split('document.location').join('document.__location__yproxy__');
  out = out.split('location.href').join('__location__yproxy__.href');
  out = out.split('location.replace(').join('__location__yproxy__.replace(');
  out = out.split('location.assign(').join('__location__yproxy__.assign(');
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
