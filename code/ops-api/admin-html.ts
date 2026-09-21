/**
 * admin-html.ts — /admin 管理页（原生 JS 单页，无构建链）
 *
 * 交互面：MCP 服务器卡片（启停/删除/新增）、技能网格（开关）、依赖健康条、
 * 系统状态（revision）。key 存 localStorage，fetch 带 Bearer；401 时提示重输。
 * 单文件内联的原因：页面随插件分发，避免运行时读文件路径耦合。
 */
export const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>i2Stream Ops — 管理面</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 system-ui, "Segoe UI", sans-serif; background: #0f1419; color: #e7ecf3; }
  header { display: flex; align-items: center; gap: 12px; padding: 14px 20px; background: #161d26; border-bottom: 1px solid #232d3a; position: sticky; top: 0; }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  .health { display: flex; gap: 10px; margin-left: auto; font-size: 12px; }
  .health .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; }
  .ok { background: #3fb950; } .bad { background: #f85149; }
  main { max-width: 960px; margin: 0 auto; padding: 20px; }
  section { margin-bottom: 28px; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .06em; color: #8b98a9; margin: 0 0 12px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
  .card { background: #161d26; border: 1px solid #232d3a; border-radius: 8px; padding: 12px 14px; }
  .card h3 { margin: 0 0 6px; font-size: 14px; display: flex; align-items: center; gap: 8px; }
  .card .meta { font-size: 12px; color: #8b98a9; word-break: break-all; }
  .card .actions { margin-top: 10px; display: flex; gap: 8px; }
  button { background: #21262d; color: #e7ecf3; border: 1px solid #30363d; border-radius: 6px; padding: 5px 12px; font-size: 12px; cursor: pointer; }
  button:hover { background: #30363d; }
  button.danger { color: #f85149; }
  button.primary { background: #238636; border-color: #2ea043; color: #fff; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip { background: #161d26; border: 1px solid #232d3a; border-radius: 16px; padding: 4px 12px; font-size: 12px; cursor: pointer; user-select: none; }
  .chip.off { opacity: .45; text-decoration: line-through; }
  .rev { font-size: 11px; color: #6e7681; font-family: ui-monospace, monospace; }
  dialog { background: #161d26; color: #e7ecf3; border: 1px solid #30363d; border-radius: 10px; padding: 20px; min-width: 340px; }
  dialog::backdrop { background: rgba(0,0,0,.55); }
  dialog label { display: block; font-size: 12px; color: #8b98a9; margin: 10px 0 2px; }
  dialog input { width: 100%; background: #0f1419; color: #e7ecf3; border: 1px solid #30363d; border-radius: 6px; padding: 6px 8px; font-size: 13px; }
  dialog .row { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; }
  #toast { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); background: #21262d; border: 1px solid #30363d; padding: 8px 16px; border-radius: 8px; font-size: 13px; display: none; z-index: 9; }
</style>
</head>
<body>
<header>
  <h1>i2Stream Ops · 管理面</h1>
  <div class="health" id="health"></div>
  <button onclick="clearKey(); refresh()">切换 Key</button>
</header>
<main>
  <section>
    <h2>MCP 服务器 <span class="rev" id="rev"></span></h2>
    <div class="cards" id="mcp-list"></div>
    <p><button class="primary" onclick="openAdd()">＋ 新增 MCP 服务器</button></p>
  </section>
  <section>
    <h2>技能（新会话生效）</h2>
    <div class="chips" id="skills"></div>
  </section>
</main>
<dialog id="dlg">
  <h3 id="dlg-title" style="margin:0 0 4px">新增 MCP 服务器</h3>
  <label>服务名（[A-Za-z0-9_-]，工具前缀 mcp__&lt;name&gt;__）</label>
  <input id="f-name" placeholder="e.g. kubernetes">
  <label>传输</label>
  <input id="f-transport" value="streamable-http">
  <label>URL（streamable-http）</label>
  <input id="f-url" placeholder="http://127.0.0.1:8080/mcp">
  <label>Authorization 头（可选）</label>
  <input id="f-auth" placeholder="Bearer sk-...">
  <label>command（stdio）</label>
  <input id="f-cmd" placeholder="e.g. npx -y mcp-server-k8s">
  <div class="row">
    <button onclick="dlg.close()">取消</button>
    <button class="primary" onclick="submitAdd()">写入托管段</button>
  </div>
</dialog>
<div id="toast"></div>
<script>
const K = 'ops-admin-key';
let state = null;
// 首次弹窗输入后写回 localStorage；后续 api() 调用不再重复弹窗
function key() {
  let k = localStorage.getItem(K) || '';
  if (!k) { k = (prompt('输入 OPS_ADMIN_KEY') || '').trim(); if (k) localStorage.setItem(K, k); }
  return k;
}
const auth = () => ({ Authorization: 'Bearer ' + key() });
function toast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.style.display = 'block'; setTimeout(() => t.style.display = 'none', 2600); }
function clearKey() { localStorage.removeItem(K); }
async function api(path, opts = {}) {
  const resp = await fetch(path, { ...opts, headers: { ...auth(), 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (resp.status === 401) {
    // 不做 reload（会形成循环）；清 key 后等用户点「重新输入」
    clearKey();
    if (confirm('Key 无效，重新输入？')) { state = null; refresh(); }
    else { document.getElementById('mcp-list').innerHTML = '<p class="rev">鉴权失败—点右上角「切换 Key」重试</p>'; }
    throw new Error('401');
  }
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(body.error && body.error.message || resp.status);
  return body;
}
async function refresh() {
  try {
    state = await api('/admin/api/state');
    render();
  } catch (e) { /* toast 已提示 */ }
}
function render() {
  document.getElementById('rev').textContent = 'rev ' + state.revision.slice(0, 8);
  document.getElementById('health').innerHTML = Object.entries(state.health || {})
    .map(([n, s]) => '<span><span class="dot ' + (s === 'ok' ? 'ok' : 'bad') + '"></span>' + n + ' ' + s + '</span>').join('');
  document.getElementById('mcp-list').innerHTML = (state.mcp || []).map((s) => {
    const target = s.transport === 'stdio' ? (s.command || '') : (s.url || '');
    return '<div class="card"><h3>' + s.serverName + ' <span class="rev">' + s.transport + '</span></h3>'
      + '<div class="meta">' + target + '</div><div class="actions">'
      + '<button class="danger" onclick="delMcp(&quot;' + s.serverName + '&quot;)">删除</button></div></div>';
  }).join('') || '<p class="rev">托管段为空——用「新增」添加第一个 MCP 服务器</p>';
  document.getElementById('skills').innerHTML = (state.skills || []).map((s) =>
    '<span class="chip ' + (s.enabled ? '' : 'off') + '" onclick="toggleSkill(&quot;' + s.name + '&quot;,' + s.enabled + ')">' + s.name + '</span>').join('') || '<p class="rev">无技能目录</p>';
}
async function delMcp(name) {
  if (!confirm('删除 MCP 服务器 ' + name + '？热更后新会话工具消失')) return;
  try { await api('/admin/api/mcp/' + encodeURIComponent(name) + '?revision=' + state.revision, { method: 'DELETE' }); toast('已删除 ' + name); refresh(); }
  catch (e) { toast('删除失败: ' + e.message); }
}
async function toggleSkill(name, enabled) {
  try { await api('/admin/api/skills/' + encodeURIComponent(name) + '/' + (enabled ? 'disable' : 'enable'), { method: 'POST' }); toast(name + (enabled ? ' 已停用' : ' 已启用') + '（新会话生效）'); refresh(); }
  catch (e) { toast('操作失败: ' + e.message); }
}
const dlg = document.getElementById('dlg');
function openAdd() { dlg.showModal(); }
async function submitAdd() {
  const payload = {
    serverName: document.getElementById('f-name').value.trim(),
    transport: document.getElementById('f-transport').value.trim() || 'streamable-http',
    url: document.getElementById('f-url').value.trim() || undefined,
    headers: document.getElementById('f-auth').value.trim() ? { Authorization: document.getElementById('f-auth').value.trim() } : undefined,
    command: document.getElementById('f-cmd').value.trim() || undefined,
    revision: state && state.revision,
  };
  if (payload.transport === 'stdio' && payload.command) { const parts = payload.command.split(/\s+/); payload.command = parts[0]; payload.args = parts.slice(1); }
  try { await api('/admin/api/mcp', { method: 'POST', body: JSON.stringify(payload) }); dlg.close(); toast('已写入托管段，热更生效'); refresh(); }
  catch (e) { toast('写入失败: ' + e.message); }
}
refresh();
setInterval(refresh, 30000);
</script>
</body>
</html>`;
