// mdview 实时预览插件（需求 167：VS Code 版，与 Sublime 插件 165/166 能力对齐；
// 需求 333：联动能力对齐 Sublime 现版 + 本机无 mdview 时引导官网安装；
// 2026-10-15 回归修复：findExe 认带版本后缀的 mdview、优先选支持 live 的候选）
//
// 在 VS Code 中编辑 Markdown 时，把【未保存】的缓冲区内容实时推送给本机 mdview
// 预览窗口，实现与 mdview F3 分屏编辑一致的「边输入边无感刷新」；并支持位置双向
// 同步（光标跟随滚动 / 预览点击回跳 / 预览选中同步选中源码）。
// 同时支持国际版 mdpeek（原 mdview 国际版已独立品牌，官网 mdpeek.net）——
// 协议完全一致，live session 目录按各自品牌名分居。
//
// 工作原理（协议同 Sublime 插件，服务端实现见 src/server.rs `/_live/*`）：
//   每个预览实例启动时在 live session 目录登记 <port>.json：
//       Windows: %LOCALAPPDATA%\mdview\live\ 与 %LOCALAPPDATA%\mdpeek\live\
//       macOS:   ~/.cache/mdview/live/ 与 ~/.cache/mdpeek/live/
//   内容为 {"pid", "port", "token", "md_file", "version"}。
//   本插件按当前文件路径匹配实例，GET /_live/ping 校验存活后，
//   带 x-mdview-token POST /_live/push 推送全文；反向经 SSE /_events 收
//   live-nav:<line>（点击回跳）与 live-select:{a,b,t}（选中同步）。
//
// 注意：实时推送端点为 Pro 功能；社区版返回 404，插件静默待机。

const vscode = require('vscode');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');

const MD_EXTS = ['.md', '.markdown', '.mdown', '.mkdn', '.mkd', '.mdtxt', '.mdtext'];

// 服务端 axum 默认请求体上限 2MB，留余量
const MAX_PUSH_BYTES = 1800 * 1024;
// 选中文本超过该长度不携带（退化为整行选中）
const SEL_MAX_TEXT = 4000;

const pendingGen = new Map();   // uri -> int，内容推送防抖世代
const lastSent = new Map();     // uri -> string，上次已推送内容（相同则跳过）
const lastPushTs = new Map();   // uri -> ts，上次实际推送时间（领先+尾随节流，333-1）
const session = new Map();      // normpath -> {port, token, path} 已校验实例
const negative = new Map();     // normpath -> ts，无实例负缓存
const notified = new Set();     // 已提示过的状态，避免刷屏
const NEGATIVE_TTL = 2000;      // 无实例时重新扫描间隔（毫秒）

const cursorGen = new Map();    // uri -> int，光标推送防抖世代
const cursorScan = new Map();   // normpath -> ts，光标路径上的低频实例发现
const lastCursor = new Map();   // uri -> int，上次已推送的光标行
const navApplied = new Map();   // uri -> {line, ts}，live-nav/select 落点回声抑制
const sse = new Map();          // port -> {stop, failures, timer, req}
const CURSOR_DEBOUNCE_MS = 150; // 光标停驻 150ms 才推送（与内容防抖 300ms 分开）
const CURSOR_SCAN_TTL = 3000;   // 无缓存会话时光标路径的实例发现间隔
const SSE_GIVE_UP = 10;         // SSE 连续重连失败次数上限，实例已退出

// —— 需求 333：mdview/mdpeek 缺失时的官网引导（不做自动下载/静默安装，用户自行装 Pro） ——
// 中文用户 → 国内版 mdview 下载页（mdview.cn），其余 → 国际版 mdpeek（mdpeek.net；
// 原 mdview 国际版 mdview.top 已更名并 301 过去）；两版配置/付费/更新通道完全隔离
// （需求 200），装错版须卸载重装，判定保守+可覆写。
const CHANNEL_DOWNLOAD_PAGE = {
    cn: 'https://www.mdview.cn/download.html',
    intl: 'https://www.mdpeek.net/download',
};

function cfg() {
    return vscode.workspace.getConfiguration('mdview');
}

function enabled() {
    return cfg().get('enabled', true);
}

function syncCursor() {
    return cfg().get('syncCursor', true);
}

function debounceMs() {
    const v = Number(cfg().get('debounceMs', 300));
    return Number.isFinite(v) ? Math.max(50, v) : 300;
}

// —— 调试日志（mdview.debugLog 开关 → 「mdview」输出通道），对齐 Sublime 版 _dbg ——
let dbgChannel = null;
function dbg(msg) {
    try {
        if (!cfg().get('debugLog', false)) return;
        if (!dbgChannel) dbgChannel = vscode.window.createOutputChannel('mdview');
        const now = new Date();
        dbgChannel.appendLine(now.toTimeString().slice(0, 8) + '.'
            + String(now.getMilliseconds()).padStart(3, '0') + ' ' + msg);
    } catch (e) { /* 日志绝不影响主流程 */ }
}

// 版本通道判定（纯函数，可单测）：设置显式指定优先（cn/intl——自动判定误伤的
// 逃生口，如英文界面但买国内版的用户）；auto = 界面语言 zh 开头 → 国内版，
// 其余 → 国际版（与产品 GEO 分流口径一致）。language 传 vscode.env.language。
function resolveChannel(pref, language) {
    const v = String(pref || 'auto').toLowerCase();
    if (v === 'cn' || v === 'intl') return v;
    return String(language || '').toLowerCase().startsWith('zh') ? 'cn' : 'intl';
}

function channel() {
    return resolveChannel(cfg().get('channel', 'auto'), vscode.env.language);
}

// 版本串 → 数字数组（可逐元素比较；非数字段丢弃，全空给 [] 视为最旧）。
// 同 Sublime 版 _version_key。
function versionKey(s) {
    return String(s || '').split('.')
        .filter((p) => /^\d+$/.test(p))
        .map(Number);
}

function cmpVersionKey(a, b) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
        const x = a[i] || 0;
        const y = b[i] || 0;
        if (x !== y) return x - y;
    }
    return 0;
}

function liveDirs() {
    // 国内版 mdview 与国际版 mdpeek 各一处（协议一致，注册目录按品牌名分居
    // ——mdpeek 的 APP_DIR_NAME 就是 "mdpeek"），扫描全查。
    if (process.platform === 'win32') {
        const base = process.env.LOCALAPPDATA || process.env.APPDATA || '';
        return [path.join(base, 'mdview', 'live'),
                path.join(base, 'mdpeek', 'live')];
    }
    const cache = path.join(os.homedir(), '.cache');
    return [path.join(cache, 'mdview', 'live'),
            path.join(cache, 'mdpeek', 'live')];
}

function norm(p) {
    const r = path.resolve(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
}

function isMarkdownDoc(doc) {
    if (!doc || doc.uri.scheme !== 'file') return false;
    const ext = path.extname(doc.uri.fsPath).toLowerCase();
    return MD_EXTS.includes(ext);
}

// —— HTTP ——

function httpRequest(method, url, token, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const data = payload !== undefined ? Buffer.from(JSON.stringify(payload), 'utf-8') : null;
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['x-mdview-token'] = token;
        if (data) headers['Content-Length'] = data.length;
        const req = http.request({
            hostname: u.hostname, port: u.port, path: u.pathname,
            method, headers, timeout: timeoutMs || 2000,
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                res.bodyText = Buffer.concat(chunks).toString('utf-8');
                resolve(res);
            });
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

class HttpError extends Error {
    constructor(status) {
        super('HTTP ' + status);
        this.status = status;
    }
}

async function post(entry, endpoint, payload) {
    const res = await httpRequest(
        'POST', `http://127.0.0.1:${entry.port}${endpoint}`, entry.token, payload);
    if (res.statusCode >= 400) throw new HttpError(res.statusCode);
    return res;
}

// 需求 340 §2.6：entry（live 注册表 / `/_live/ping` 响应）是否指向这个文件。
// tabs 模式下 `md_file` 只记**激活 tab** 的文档，窗口里其它已开 tab 的文档在
// `files[]` 里（ping 与注册表同款下发）。只认 md_file 会让「后台 tab 的文件」
// 找不到会话——插件于是另起窗口，req 8 的「自动激活对应 tab」走不到。
// files[] 缺席（老版本 exe）时行为与旧版完全一致。
function entryMatches(entry, filePath) {
    const target = norm(filePath);
    if (entry.md_file && norm(entry.md_file) === target) return true;
    const files = entry.files;
    if (Array.isArray(files)) {
        for (const f of files) {
            if (typeof f === 'string' && norm(f) === target) return true;
        }
    }
    return false;
}

async function ping(entry, filePath) {
    try {
        const res = await httpRequest(
            'GET', `http://127.0.0.1:${entry.port}/_live/ping`, null, undefined, 1500);
        if (res.statusCode !== 200) return false;
        const data = JSON.parse(res.bodyText);
        return !!(data.ok && entryMatches(data, filePath));
    } catch (e) {
        return false;
    }
}

// —— 实例发现（live session 目录） ——

async function scanSessions(filePath) {
    let best = null;
    for (const live of liveDirs()) {
        let names;
        try {
            names = fs.readdirSync(live);
        } catch (e) {
            continue;
        }
        for (const name of names) {
            if (!name.endsWith('.json')) continue;
            const fpath = path.join(live, name);
            let entry;
            try {
                entry = JSON.parse(fs.readFileSync(fpath, 'utf-8'));
            } catch (e) {
                continue;
            }
            if (!entryMatches(entry, filePath)) continue;
            if (await ping(entry, filePath)) {
                // 同一文件被多个实例同时预览时采信版本最高的（新旧 exe 混开时，
                // 避免栓在不支持新端点的旧实例上）——Sublime 版同款（333-1）
                if (!best
                        || cmpVersionKey(versionKey(entry.version), versionKey(best.version)) > 0) {
                    best = entry;
                }
                continue;
            }
            // 死实例（进程崩溃残留）→ 删除，下次不再尝试
            try { fs.unlinkSync(fpath); } catch (e) { /* ignore */ }
        }
    }
    return best;
}

async function findSession(filePath) {
    const key = norm(filePath);
    const cached = session.get(key);
    if (cached) return cached;
    const neg = negative.get(key) || 0;
    if (Date.now() - neg < NEGATIVE_TTL) return null;
    const entry = await scanSessions(filePath);
    if (entry) {
        entry.path = filePath;
        session.set(key, entry);
        ensureSse(entry); // 会话建立即起反向监听（预览点击/选中 → 编辑器）
        return entry;
    }
    negative.set(key, Date.now());
    return null;
}

function dropSession(filePath) {
    session.delete(norm(filePath));
    negative.set(norm(filePath), 0); // 立即允许重扫
}

function statusOnce(key, msg) {
    if (notified.has(key)) return;
    notified.add(key);
    vscode.window.setStatusBarMessage(msg, 8000);
}

// —— 正向：内容推送 ——

async function pushDoc(doc) {
    if (!enabled() || !isMarkdownDoc(doc)) return;
    const filePath = doc.uri.fsPath;
    const uri = doc.uri.toString();
    const content = doc.getText();
    if (lastSent.get(uri) === content) return;
    if (Buffer.byteLength(content, 'utf-8') > MAX_PUSH_BYTES) {
        statusOnce('too-large', 'mdview: 文件过大，实时预览推送已跳过');
        return;
    }
    let entry = await findSession(filePath);
    if (!entry) return;
    try {
        await post(entry, '/_live/push', { path: filePath, content });
        lastSent.set(uri, content);
        lastPushTs.set(uri, Date.now());
        dbg('push ' + Buffer.byteLength(content, 'utf-8') + ' bytes ok');
    } catch (e) {
        if (e instanceof HttpError) {
            if (e.status === 404) {
                // 社区版无此端点：长时间负缓存，本次会话不再打扰
                statusOnce('404', 'mdview: 实时预览推送需要 Pro 版本');
                negative.set(norm(filePath), Date.now() + 3600000);
                session.delete(norm(filePath));
            } else if (e.status === 409 || e.status === 403) {
                // 409：窗口已切到别的文件；403：token 失效（实例重启）→ 重扫
                dropSession(filePath);
            }
            return;
        }
        // 连接失败：实例可能刚重启（缓存会话指向死端口）——立即重扫补推一次，
        // 避免丢掉首个按键（166 踩坑修复的 VS Code 同款）
        dropSession(filePath);
        entry = await findSession(filePath);
        if (!entry) return;
        try {
            await post(entry, '/_live/push', { path: filePath, content });
            lastSent.set(uri, content);
            lastPushTs.set(uri, Date.now());
            dbg('push retry ok');
        } catch (e2) {
            dropSession(filePath);
        }
    }
}

// —— 正向：光标行推送 ——

async function pushCursor(editor) {
    if (!enabled() || !syncCursor() || !isMarkdownDoc(editor.document)) return;
    const doc = editor.document;
    const filePath = doc.uri.fsPath;
    const uri = doc.uri.toString();
    if (!editor.selection) return;
    const line = editor.selection.start.line + 1;
    if (lastCursor.get(uri) === line) return;
    // 回声抑制：该行刚由 live-nav/live-select 应用（预览点回来的），不回推
    const na = navApplied.get(uri);
    if (na && na.line === line && Date.now() - na.ts < 1500) {
        lastCursor.set(uri, line);
        return;
    }
    let entry = session.get(norm(filePath));
    if (!entry) {
        // 光标事件很频繁，无缓存会话时只能低频尝试发现（内容推送链路自带发现）
        const key = norm(filePath);
        const now = Date.now();
        if (now - (cursorScan.get(key) || 0) < CURSOR_SCAN_TTL) return;
        cursorScan.set(key, now);
        entry = await findSession(filePath);
        if (!entry) return;
    }
    lastCursor.set(uri, line);
    try {
        await post(entry, '/_live/cursor', { path: filePath, line });
    } catch (e) {
        if (e instanceof HttpError) {
            if (e.status === 404) {
                negative.set(norm(filePath), Date.now() + 3600000);
                session.delete(norm(filePath));
            } else if (e.status === 403 || e.status === 409) {
                dropSession(filePath);
            }
        } else {
            dropSession(filePath);
        }
    }
}

// —— 反向：SSE 监听（预览 → 编辑器） ——

function ensureSse(entry) {
    const port = entry.port;
    const st = sse.get(port);
    if (st && !st.stop) return;
    const state = { stop: false, failures: 0, timer: null, req: null };
    sse.set(port, state);
    sseConnect(port, entry.token, entry.path || '', state);
}

function sseConnect(port, token, filePath, state) {
    if (state.stop) return;
    const req = http.get({
        hostname: '127.0.0.1', port, path: '/_events',
        headers: { 'x-mdview-token': token }, timeout: 30000,
        // 服务端 keep-alive 每 15s 一行注释，30s 读超时不会误杀健康连接
    }, (res) => {
        if (res.statusCode !== 200) {
            res.resume();
            dbg('sse http-' + res.statusCode + ' port=' + port);
            scheduleReconnect(port, token, filePath, state);
            return;
        }
        state.failures = 0;
        dbg('sse connected port=' + port);
        let buf = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk) => {
            buf += chunk;
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, idx).trim();
                buf = buf.slice(idx + 1);
                handleSseLine(line, filePath);
            }
        });
        res.on('end', () => scheduleReconnect(port, token, filePath, state));
        res.on('error', () => scheduleReconnect(port, token, filePath, state));
    });
    state.req = req;
    req.on('timeout', () => req.destroy());
    req.on('error', () => scheduleReconnect(port, token, filePath, state));
}

function scheduleReconnect(port, token, filePath, state) {
    if (state.stop || state.timer) return;
    state.failures += 1;
    if (state.failures >= SSE_GIVE_UP) {
        dbg('sse give-up port=' + port);
        sse.delete(port); // 实例大概率已退出，放弃（会话重建立时会再起）
        return;
    }
    state.timer = setTimeout(() => {
        state.timer = null;
        sseConnect(port, token, filePath, state);
    }, 2000);
}

function handleSseLine(line, filePath) {
    if (line.startsWith('data: live-nav:')) {
        const n = parseInt(line.slice('data: live-nav:'.length), 10);
        if (n > 0) {
            dbg('sse live-nav line=' + n);
            applyNav(filePath, n);
        }
    } else if (line.startsWith('data: live-select:')) {
        let p;
        try {
            p = JSON.parse(line.slice('data: live-select:'.length));
        } catch (e) {
            dbg('sse live-select parse-error');
            return;
        }
        dbg('sse live-select a=' + (p.a || 0) + ' b=' + (p.b || 0)
            + ' t=' + (p.t || '').length + ' chars');
        applySelect(filePath, p.a || 0, p.b || 0, p.t || '');
    }
}

function stopSseFor(filePath) {
    const entry = session.get(norm(filePath));
    if (!entry) return;
    for (const doc of vscode.workspace.textDocuments) {
        if (doc.uri.scheme === 'file' && norm(doc.uri.fsPath) === norm(filePath)) {
            return; // 仍有文档使用该文件
        }
    }
    const st = sse.get(entry.port);
    if (st) {
        st.stop = true;
        if (st.timer) clearTimeout(st.timer);
        if (st.req) st.req.destroy();
        sse.delete(entry.port);
    }
}

// —— 反向落位：点击回跳 / 选中同步 ——

async function findEditor(filePath) {
    const target = norm(filePath);
    for (const ed of vscode.window.visibleTextEditors) {
        if (ed.document.uri.scheme === 'file'
                && norm(ed.document.uri.fsPath) === target) {
            return ed;
        }
    }
    for (const doc of vscode.workspace.textDocuments) {
        if (doc.uri.scheme === 'file' && norm(doc.uri.fsPath) === target) {
            // showTextDocument 只聚焦 VS Code 内编辑器组，不抬升 OS 窗口
            return vscode.window.showTextDocument(doc, { preview: false });
        }
    }
    return null;
}

async function applyNav(filePath, line) {
    const ed = await findEditor(filePath);
    if (!ed) return;
    const doc = ed.document;
    const uri = doc.uri.toString();
    const row = Math.max(0, Math.min(line - 1, doc.lineCount - 1));
    // 回声抑制置位必须先于选区修改（onDidChangeTextEditorSelection 随即触发）
    navApplied.set(uri, { line: row + 1, ts: Date.now() });
    lastCursor.set(uri, row + 1);
    const pos = new vscode.Position(row, 0);
    ed.selection = new vscode.Selection(pos, pos);
    ed.revealRange(new vscode.Range(pos, pos),
        vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

// 空白归一 + 索引回映：连续空白折叠为单个空格（首尾不留），
// map[i] = 归一文本第 i 字符在原串中的偏移（同 Sublime 插件 _sel_norm_map）
function selNormMap(s) {
    let out = '';
    const map = [];
    let lastWs = true; // 起始视为空白：前导空白不产生空格
    for (let i = 0; i < s.length; i++) {
        const c = s.charAt(i);
        if (/\s/.test(c)) {
            if (!lastWs) { out += ' '; map.push(i); }
            lastWs = true;
        } else {
            out += c; map.push(i);
            lastWs = false;
        }
    }
    if (out.endsWith(' ')) { out = out.slice(0, -1); map.pop(); }
    return { text: out, map };
}

// 在源码区间 region 中定位渲染选中文本 text，返回 {start,end} 或 null。
// 精确 → 去首尾空白 → 空白归一 → 头尾锚点 逐级定位（同 mdview 147 selLocate）。
function locateInRegion(region, text) {
    let i = region.indexOf(text);
    if (i >= 0) return { start: i, end: i + text.length };
    const trimmed = text.trim();
    if (trimmed && trimmed !== text) {
        i = region.indexOf(trimmed);
        if (i >= 0) return { start: i, end: i + trimmed.length };
    }
    // 空白归一：段落跨源码行/跨块选区的换行差异（CRLF、块边界 \n 数不一致）在此拉齐
    const nr = selNormMap(region);
    const nt = selNormMap(text).text;
    if (!nt) return null;
    const j = nr.text.indexOf(nt);
    if (j >= 0) return { start: nr.map[j], end: nr.map[j + nt.length - 1] + 1 };
    // 头尾锚点：选区文字被行内格式符号（**、` 等）截断时，按归一首尾各 4 字符夹出区间
    //（命中段会带上中间的格式符号，可接受的近似）；过短文本锚点歧义大，不用
    if (nt.length > 4) {
        const head = nt.slice(0, 4);
        const tail = nt.slice(-4);
        const hs = nr.text.indexOf(head);
        const te = nr.text.lastIndexOf(tail);
        if (hs >= 0 && te >= hs) {
            const s = nr.map[hs];
            const e = nr.map[te + tail.length - 1] + 1;
            if (e > s) return { start: s, end: e };
        }
    }
    return null;
}

// 纯函数（可单测）：在 docText 中计算 lineA..lineB（1 起，lineB<=0 表示至文末）
// 区间内 text 对应的字符偏移 {start,end}；text 缺失或定位失败退化为整行区间。
function computeSelectOffsets(docText, lineA, lineB, text) {
    const lines = docText.split('\n');
    const total = lines.length;
    const a = Math.max(1, Math.min(lineA || 1, total));
    const b = (!lineB || lineB <= 0 || lineB > total) ? total : Math.max(a, lineB);
    let start = 0;
    for (let i = 0; i < a - 1; i++) start += lines[i].length + 1;
    let end = start;
    for (let i = a - 1; i < b; i++) end += lines[i].length + (i < b - 1 ? 1 : 0);
    if (text && text.length <= SEL_MAX_TEXT) {
        const region = docText.slice(start, end);
        const hit = locateInRegion(region, text);
        if (hit) return { start: start + hit.start, end: start + hit.end };
        // 文本对不上（公式/复杂 html 块等）→ 退化为选中覆盖到的整段源码行
    }
    return { start, end };
}

async function applySelect(filePath, lineA, lineB, text) {
    if (!syncCursor()) return;
    const ed = await findEditor(filePath);
    if (!ed) return;
    const doc = ed.document;
    const uri = doc.uri.toString();
    const r = computeSelectOffsets(doc.getText(), lineA, lineB, text);
    const s = doc.positionAt(r.start);
    const e = doc.positionAt(r.end);
    // 回声抑制：pushCursor 取 selection.start 所在行，此处即区间起点
    navApplied.set(uri, { line: s.line + 1, ts: Date.now() });
    lastCursor.set(uri, s.line + 1);
    ed.selection = new vscode.Selection(s, e);
    ed.revealRange(new vscode.Range(s, s),
        vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

// —— mdview 可执行文件定位 ——

function regQuery(args) {
    return new Promise((resolve) => {
        execFile('reg', args, { windowsHide: true }, (err, stdout) => {
            resolve(err ? null : String(stdout));
        });
    });
}

function regValue(out) {
    // 形如 "    ProgId    REG_SZ    MdView" 或 "    (默认)    REG_SZ    ..."
    if (!out) return null;
    for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^\s+\S+\s+REG_\S+\s+(.*)$/);
        if (m) return m[1].trim();
    }
    return null;
}

// 名字判定：mdview/mdpeek 的正式版/便携包/dev 构建常带后缀（mdview-pro_1.0.191.exe、
// mdpeek-pro_1.0.5.exe）——严格等于 mdview.exe 会把用户实际的「打开方式」否掉
// （2026-10-15 回归：本机关联指向 mdview-pro_1.0.191.exe 被拒 → 退回旧构建 →
// 旧 exe 无 live 协议，表现为完全无联动）。-en 后缀留给退役的旧国际版存量安装
// （改名的构建另有二进制自证兜底）。
function looksLikeMdviewName(exe) {
    return /^(mdview|mdpeek)(-pro|-en)?(_[\d.]+)?\.exe$/i.test(path.basename(exe));
}

// 二进制自证 + live 能力探测：mdview 的 Pro 构建（含实时推送协议）里带
// `_live/ping` 端点字符串，社区版不带。一次读盘同时回答「是不是 mdview」
//（改名/带后缀的构建也能认）与「支不支持联动」，用于候选择优。
const liveProbeCache = new Map(); // exe -> bool
function exeHasLive(exe) {
    if (liveProbeCache.has(exe)) return liveProbeCache.get(exe);
    let ok = false;
    try {
        ok = fs.readFileSync(exe).includes('_live/ping');
    } catch (e) {
        ok = false; // 读不了（权限/占用）按不支持处理，不影响定位
    }
    liveProbeCache.set(exe, ok);
    return ok;
}

// Windows：按 .md 文件关联（用户实际的「打开方式」）定位 mdview.exe。
// 采信条件：名字像 mdview（允许版本后缀），或二进制自证是 mdview（改名/便携包）；
// 关联到其它编辑器（Typora、VS Code 等）则跳过走兜底。
async function findExeAssoc() {
    if (process.platform !== 'win32') return null;
    let progId = regValue(await regQuery(['query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.md\\UserChoice',
        '/v', 'ProgId']));
    if (!progId) {
        progId = regValue(await regQuery(['query', 'HKCR\\.md', '/ve']));
    }
    if (!progId) return null;
    const cmd = regValue(await regQuery(['query',
        `HKCR\\${progId}\\shell\\open\\command`, '/ve']));
    if (!cmd) return null;
    const m = cmd.match(/^"([^"]+)"/) || cmd.match(/^(\S+)/);
    const exe = m && m[1];
    if (exe && fs.existsSync(exe)
            && (looksLikeMdviewName(exe) || exeHasLive(exe))) {
        return exe;
    }
    return null;
}

// 注册表 InstallDir 定位已安装的 app（需求 333）：国内版 PRODUCT_ID=mdview、
// 国际版 mdpeek（各自 installer.nsi 的 PRODUCT_ID；mdpeek 无 -en 后缀，exe 同名）。
// 原 international mdview-en 已退役（更名 mdpeek，mdview.top 301 → mdpeek.net），
// 不再探测。两视图都查——安装器为 32 位 NSIS 时写的键落在 WOW6432Node，
// 64 位 reg.exe 默认视图看不见。
async function installedExeViaRegistry(ch) {
    if (process.platform !== 'win32') return null;
    const productId = ch === 'intl' ? 'mdpeek' : 'mdview';
    for (const view of ['/reg:64', '/reg:32']) {
        const dir = regValue(await regQuery(['query',
            `HKLM\\SOFTWARE\\${productId}`, '/v', 'InstallDir', view]));
        if (!dir) continue;
        const exe = path.join(dir, productId + '.exe');
        if (fs.existsSync(exe)) return exe;
    }
    return null;
}

async function findExe() {
    const configured = cfg().get('path') || '';
    if (configured && fs.existsSync(configured)) return configured;
    const found = [];
    const assoc = await findExeAssoc();
    if (assoc) found.push(assoc);
    for (const ch of ['cn', 'intl']) {
        const exe = await installedExeViaRegistry(ch);
        if (exe) found.push(exe);
    }
    const candidates = [];
    if (process.platform === 'win32') {
        for (const envVar of ['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA']) {
            const base = process.env[envVar];
            if (!base) continue;
            for (const productId of ['mdview', 'mdpeek']) {
                candidates.push(path.join(base, productId, productId + '.exe'));
                candidates.push(path.join(base, 'Programs', productId, productId + '.exe'));
            }
        }
    } else {
        for (const app of ['mdview', 'mdpeek']) {
            candidates.push(`/Applications/${app}.app/Contents/MacOS/${app}`);
            candidates.push(path.join(os.homedir(),
                'Applications', `${app}.app`, 'Contents', 'MacOS', app));
        }
    }
    for (const c of candidates) {
        if (fs.existsSync(c)) found.push(c);
    }
    // PATH 兜底
    for (const app of ['mdview', 'mdpeek']) {
        const name = process.platform === 'win32' ? app + '.exe' : app;
        for (const d of (process.env.PATH || '').split(path.delimiter)) {
            if (!d) continue;
            const p = path.join(d, name);
            if (fs.existsSync(p)) found.push(p);
        }
    }
    // 候选里优先取**支持实时推送**的那台（Pro）——本机常见多版本残留（Program Files
    // 旧构建 / 注册表 InstallDir 指向的旧安装），旧 exe 没有 live 协议，选中即「打开
    // 了窗口但完全无联动」。一台带 live 的都没有时（社区版）退而取优先级最高的：
    // 窗口照常打开，推送时由 404 分支提示「需要 Pro 版本」。
    for (const e of found) {
        if (exeHasLive(e)) return e;
    }
    return found[0] || null;
}

// —— 需求 333：本机没有 mdview/mdpeek 时，引导前往官网自行下载安装 Pro 版 ——
// （不做自动下载/静默安装：用户拍板让安装这件事发生在浏览器与安装器里）
// 下载页按 channel 自动分流（中文界面 → 国内版 mdview，其余 → 国际版 mdpeek，
// 可设置覆写）。
async function promptDownload() {
    const ch = channel();
    const product = ch === 'intl' ? 'mdpeek' : 'mdview';
    const tag = ch === 'cn' ? '国内版' : '国际版';
    const pick = await vscode.window.showInformationMessage(
        '本插件的实时预览依赖 ' + product + ' 桌面版（Pro），需要从 ' + product
        + ' 官网下载安装（' + tag + '），是否继续？', '继续（打开下载页）', '取消');
    if (pick === '继续（打开下载页）') {
        vscode.env.openExternal(vscode.Uri.parse(CHANNEL_DOWNLOAD_PAGE[ch]));
    }
}

// —— 激活 / 事件接线 ——

function activate(context) {
    // 内容推送：领先+尾随节流（对齐 F3/Sublime 版的 300ms throttle，333-1）——
    // 距上次实际推送已满 debounce 立即推（连续输入时每 300ms 出一帧），否则按
    // 剩余时间尾随一发；世代号保证同一时刻只有最新一发在途。原为纯防抖——
    // 连续输入期间一直不推，体感远不如 F3 实时。
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => {
        if (!enabled() || !isMarkdownDoc(e.document)) return;
        const uri = e.document.uri.toString();
        const gen = (pendingGen.get(uri) || 0) + 1;
        pendingGen.set(uri, gen);
        const doc = e.document;
        const wait = Math.max(0, debounceMs() - (Date.now() - (lastPushTs.get(uri) || 0)));
        setTimeout(() => {
            if (pendingGen.get(uri) !== gen) return; // 期间又有修改，由更新的世代接管
            pushDoc(doc);
        }, wait);
    }));

    // 激活编辑器时补建会话/SSE（333-1，对齐 Sublime 版 on_activated_async）——
    // 先开编辑器后开 mdview（或 mdview 重启、SSE 连败放弃后）且尚未编辑/移动
    // 光标时，点击/选区同步依赖的 SSE 借激活事件恢复，不必等首次输入。
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((ed) => {
        if (!ed || !enabled() || !isMarkdownDoc(ed.document)) return;
        const filePath = ed.document.uri.fsPath;
        const entry = session.get(norm(filePath));
        if (entry) {
            ensureSse(entry); // 线程已放弃则补起（内部判活，幂等）
            return;
        }
        const key = norm(filePath);
        const now = Date.now();
        if (now - (cursorScan.get(key) || 0) < CURSOR_SCAN_TTL) return;
        cursorScan.set(key, now);
        findSession(filePath);
    }));

    // 保存后立即推一次终态（多数情况与节流在途内容相同，幂等跳过）
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((doc) => {
        pushDoc(doc);
    }));

    // 光标行跟随：停驻 150ms 后推送（世代防抖同内容推送）
    context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection((e) => {
        if (!enabled() || !syncCursor() || !isMarkdownDoc(e.textEditor.document)) return;
        const uri = e.textEditor.document.uri.toString();
        const gen = (cursorGen.get(uri) || 0) + 1;
        cursorGen.set(uri, gen);
        const ed = e.textEditor;
        setTimeout(() => {
            if (cursorGen.get(uri) !== gen) return;
            pushCursor(ed);
        }, CURSOR_DEBOUNCE_MS);
    }));

    // 文档关闭：detach 解除关联 + 停掉不再使用的 SSE 线程
    context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((doc) => {
        const uri = doc.uri.toString();
        pendingGen.delete(uri);
        lastSent.delete(uri);
        lastPushTs.delete(uri);
        cursorGen.delete(uri);
        lastCursor.delete(uri);
        navApplied.delete(uri);
        if (doc.uri.scheme !== 'file') return;
        const filePath = doc.uri.fsPath;
        const entry = session.get(norm(filePath));
        stopSseFor(filePath);
        session.delete(norm(filePath));
        if (!entry) return;
        post(entry, '/_live/detach', { path: filePath }).catch(() => {});
    }));

    // 命令：在 mdview 中打开当前文件（未运行则启动 mdview）
    context.subscriptions.push(vscode.commands.registerCommand('mdview.preview', async () => {
        const ed = vscode.window.activeTextEditor;
        if (!ed || !isMarkdownDoc(ed.document)) return;
        const filePath = ed.document.uri.fsPath;
        let exe = await findExe();
        if (!exe) {
            // 需求 333：本机没有 mdview → 引导官网下载安装 Pro（装好后再次执行即可联动）
            await promptDownload();
            return;
        }
        try {
            const child = spawn(exe, [filePath], { detached: true, stdio: 'ignore' });
            child.unref();
        } catch (err) {
            vscode.window.showErrorMessage('启动 mdview 失败：' + err.message);
        }
    }));
}

function deactivate() {
    for (const st of sse.values()) {
        st.stop = true;
        if (st.timer) clearTimeout(st.timer);
        if (st.req) st.req.destroy();
    }
    sse.clear();
    if (dbgChannel) {
        dbgChannel.dispose();
        dbgChannel = null;
    }
}

module.exports = {
    activate,
    deactivate,
    // 仅供单测（stub vscode 后 require）
    _test: {
        selNormMap, locateInRegion, computeSelectOffsets, norm,
        versionKey, cmpVersionKey, resolveChannel, CHANNEL_DOWNLOAD_PAGE,
        // 需求 340 §2.6：tabs 模式会话认领（path ∪ files[]）的纯判定
        entryMatches,
        looksLikeMdviewName,
    },
};
