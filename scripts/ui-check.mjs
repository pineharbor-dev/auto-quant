/**
 * 控制台版面自检：逐页在**真实浏览器**里找客观异常。
 *
 * ## 为什么需要它
 *
 * 重做界面这十几轮里，我每一轮都在手工写一遍同样的脚本：打开页面、量正文长度、
 * 找横向溢出、收集控制台错误。那是重复劳动，而且**每次写法略有不同** ——
 * 于是"这轮查了没有"和"上轮查了没有"其实不可比。
 *
 * ## 它判什么、不判什么
 *
 * 判的是**客观异常**，不是"好不好看"：横向溢出、控制台报错、4xx/5xx、空白页、
 * **界面把 markdown 强调符当纯文本显示出来**。版面美观仍然要人看截图 ——
 * 这个脚本只负责挡住"明显坏了"的那一类。
 *
 * ## ⚠️ 缺凭据时**直接非零退出**（2026-10-17）
 *
 * 这是本次最要紧的一条修复。原来没有凭据也照跑：
 *
 *   1. 应用把未登录的访问**重定向到 `/login`**；
 *   2. 脚本量的就是**登录页** —— 实测正文长度**固定 496 字**，而判据是 `> 300`；
 *   3. 于是它报「**10 个页面没有客观异常**」全绿。带真 token 重跑，同一批页面
 *      正文是 **616–18,995 字**。
 *
 * 那种绿灯证明的是"**登录页渲染正常**"，而不是"被检查的页面正常"。在一个跑真实
 * 资金的仓库里，"验证通过"不能有这种含义 —— 所以缺凭据（或 token 已过期）时
 * 会非零退出并说明原因。闸门在 `ui-audit.mjs`。
 *
 * ## ⚠️ markdown 判据有**两条**，少一条就漏
 *
 * 判据本身（页面级 + `title` 属性）在 `ui-audit.mjs`，三个脚本共用一份 ——
 * 于是不会出现"两个工具对同一处一处报一处不报"。**抓不到什么**也在那里列成表，
 * 每次运行都会原样打出来：读一个绿灯的人必须同时知道它没证明什么。
 *
 * ## ⚠️ 横向溢出必须排除 `text-overflow: ellipsis`
 *
 * 第一版把 `scrollWidth > clientWidth` 一律算成溢出，于是 `/strategy` 报了两处
 * **假阳性**：那两个格子带着 `truncate`（省略号截断），而"内容比容器宽"正是
 * 截断的**预期状态**。真正要抓的是**另一种**情况：
 *
 *   · 没有 `ellipsis` 却溢出 → **内容真的跑出去了**（会撑出横向滚动条）
 *   · 有 `ellipsis` 但**没有 `title`** → 截掉的部分**永远看不到**，是信息丢失
 *
 * 后者比前者更隐蔽：版面看起来完全正常，只是那半句话谁也读不到。
 *
 * ## 用法
 *
 *   AQ_BASE=https://... AQ_TOKEN=<jwt> AQ_CHROME=<chrome 路径> npm run ui:check
 *   # 也认表单登录：UI_SMOKE_USER=<用户名> UI_SMOKE_PASS=<密码>
 *
 * 需要登录态，所以**不能进 CI**（CI 里没有真实部署与凭据）。它是本地/服务器上
 * 手动核对的工具，用于在每次 UI 改动之后快速过一遍全部页面。
 */
import { chromium } from 'playwright-core';
import {
  MARKDOWN_BLIND_SPOTS,
  assertLoggedIn,
  formatMarkdownReport,
  hasMarkdown,
  login,
  markdownGateEnabled,
  probeMarkdown,
  requireCredentials,
} from './ui-audit.mjs';

const BASE = process.env.AQ_BASE;
const CHROME = process.env.AQ_CHROME;
if (!BASE || !CHROME) {
  console.error('需要 AQ_BASE 与 AQ_CHROME 环境变量（见本文件顶部用法）。');
  process.exit(2);
}

/* 凭据是**前置条件**：没有它就会去量登录页，然后报一整套假绿。 */
const credentials = requireCredentials('ui-check');

const ROUTES = [
  ['/', '总览'],
  ['/traders', '机器人'],
  ['/strategy', '策略工作室'],
  ['/market', '行情'],
  ['/data', '数据与日志'],
  ['/models', 'AI 模型'],
  ['/exchanges', '交易所'],
  ['/account', '操作员账户'],
  ['/appearance', '外观'],
  ['/faq', '帮助'],
];

/*
 * 机器人详情页的 id **必须动态取**，不能写死。
 *
 * 这里原来是 `['/traders/8', '机器人详情']` —— 而机器人是会被删掉的：实测线上
 * 只剩 `#9`，`#8` 早已删除，于是这一页每次都报「控制台错误 2 条 + 4xx 2 条」，
 * **看起来像改版把页面改坏了**，实际只是脚本拿了一个不存在的 id 去撞。
 *
 * 一个会误报的检查工具比没有检查更糟：它训练人忽略它的红叉。
 *
 * ⚠️ **这个探测移到「登录之后」**（2026-10-17）：它原来在 `fetch` 里手拼
 * `authorization` 头，于是只支持 `AQ_TOKEN` 那条路径 —— 表单登录时这个请求没有
 * 凭据、返回 401，工具会**静默少查一页**（还打一句看不出严重性的提示）。
 * 现在改成在**页面里**用已建立的登录态去取（浏览器自己会带 token）。
 */

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();

const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(e.message.slice(0, 140)));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 140)); });
const badResponses = [];
page.on('response', (r) => { if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url().slice(-50)}`); });

await login(page, BASE, credentials);
/*
 * ⚠️ **必须先把登录态"落地"到站内一个页面，再断言。**
 * token 路径下 `login()` 结束时人还停在 `/login`（它只往 localStorage 写了 token），
 * 此时断言必然失败 —— 而那是断言用错了位置，不是真的没登录。
 */
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await assertLoggedIn(page, 'ui-check', credentials);

try {
  const rows = await page.evaluate(async () => {
    const token = localStorage.getItem('aq.token') ?? '';
    const res = await fetch('/api/traders', {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return null;
    const body = await res.json();
    return Array.isArray(body) ? body : (body.traders ?? []);
  });
  const first = Array.isArray(rows) ? rows[0] : null;
  if (first?.id) ROUTES.splice(2, 0, [`/traders/${first.id}`, '机器人详情']);
  else console.error('⚠️ 读不到机器人列表，跳过「机器人详情」这一页');
} catch {
  /* 取不到就**不检查这一页** —— 拿一个猜的 id 去撞只会制造假故障。 */
  console.error('⚠️ 读不到机器人列表，跳过「机器人详情」这一页');
}

let problems = 0;
/** 有 markdown 残留的页面（单列出来，免得被摘要遮掉）。 */
const mdPages = [];
/**
 * markdown 维度是否计入退出码。**默认不计入** —— 理由（含代价与翻转方式）
 * 写在 `ui-audit.mjs` 的 `markdownGateEnabled` 上：这 28 处 `title` 与 1 处正文
 * 都是真阳性，但都是已跟踪的待修项；让"每次 UI 改动的固定动作"在那之前一直红，
 * 只会训练人忽略红叉。`--markdown-gate` / `AQ_UI_MARKDOWN_GATE=1` 可让它失败。
 */
const mdGate = markdownGateEnabled();

for (const [route, label] of ROUTES) {
  const errBefore = consoleErrors.length;
  const badBefore = badResponses.length;
  await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  const m = await page.evaluate(() => {
    const realOverflow = [];
    const clippedWithoutTitle = [];
    for (const el of document.querySelectorAll('*')) {
      const s = getComputedStyle(el);
      if (s.overflowX === 'auto' || s.overflowX === 'scroll') continue;
      const over = el.scrollWidth - el.clientWidth;
      if (over <= 2 || el.clientWidth <= 100) continue;
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (s.textOverflow === 'ellipsis') {
        /* 截断是预期行为，但截掉的部分必须能从 title 看到。 */
        if (!el.getAttribute('title') && text.length > 0) {
          clippedWithoutTitle.push({ cls: (el.className || '').toString().slice(0, 60), text: text.slice(0, 40) });
        }
      } else {
        realOverflow.push({ tag: el.tagName, cls: (el.className || '').toString().slice(0, 60), over });
      }
    }
    const scroller = document.getElementById('main-scroll') ?? document.querySelector('main');
    return {
      text: (document.body.innerText || '').length,
      realOverflow: realOverflow.slice(0, 5),
      clippedWithoutTitle: clippedWithoutTitle.slice(0, 5),
      scrollable: scroller ? scroller.scrollHeight - scroller.clientHeight : null,
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });

  /* markdown 判据：与 `ui-audit` 共用同一份实现（页面级 + title）。 */
  const markdown = await page.evaluate(probeMarkdown);
  const mdHit = hasMarkdown(markdown);

  const errs = consoleErrors.length - errBefore;
  const bad = badResponses.length - badBefore;
  /*
   * 判决分两层，**逐字保留旧判据**（这样"有凭据时行为不变"是可核对的）：
   *   · `okOld` —— 改动前那五个条件，一个不动；
   *   · `fails` —— 再加上 markdown 维度，而它**只在 `--markdown-gate` 时才算失败**。
   * 页头那个字符与 `problems` 用同一个判据算，避免出现"显示 ✅ 却计入 problems"
   * 那种自相矛盾（旧版有这种形态，今天 0 处触发）。
   */
  /*
   * ## ⚠️ 「正文 > 300 字」不是空白页的正确判据（2026-10-27 实测）
   *
   * 这条阈值当初是为了挡一种**假绿灯**（见文件头）：没带凭据时应用把未登录访问
   * 重定向到 `/login`，脚本量的是登录页（正文固定 496 字），于是报"全部正常"。
   *
   * 但它把两件事混在了一个数字里：
   *
   *   · **要抓的**：页面被重定向到登录页（= 未登录 / token 过期）；
   *   · **顺带用的**：正文短 = 可能是空白页。
   *
   * 后果是**误伤正常页面**：`/strategy` 在只有一条策略时正文正好 300 字
   * （表头 + 一行 + 两句说明），而判据是 `> 300` —— 于是它**永远红**，
   * 而页面上没有任何客观异常。一个因为"内容刚好少"而变红的检查，
   * 会训练人忽略红叉 —— 本仓对这种事的立场写在 `<文件头>` 与 `docs/AGENTS.md` 里。
   *
   * ## 改法：直接判「是不是停在了登录页」
   *
   * 重定向到登录页有一个**确定可判**的形状：最终 URL 是 `/login`。
   * 那比"正文够不够长"准确得多，也不会随页面内容多少而漂移。
   * 正文长度只保留一个**极低的下限**（`> 50`）用来抓"渲染成空白"，
   * 不再拿它当"是不是登录页"的替身。
   */
  const landedOnLogin = /\/login(?:[?#]|$)/.test(page.url());
  if (landedOnLogin) {
    console.log(`      ❌ 被重定向到登录页（${page.url()}）—— 未登录或 token 已过期`);
  }
  const blank = m.text <= 50;
  if (blank) console.log(`      ❌ 正文只有 ${m.text} 字 —— 页面可能渲染成空白`);

  const okOld =
    !landedOnLogin &&
    !blank &&
    m.realOverflow.length === 0 &&
    m.docOverflow <= 0 &&
    errs === 0 &&
    bad === 0;
  const fails = !okOld || m.clippedWithoutTitle.length > 0 || (mdHit && mdGate);
  if (fails) problems++;
  if (mdHit) mdPages.push({ route, ...markdown });

  console.log(
    `  ${route.padEnd(13)} ${label.padEnd(7)} 正文 ${String(m.text).padStart(6)} 字  可滚 ${String(m.scrollable).padStart(5)}px  ${
      fails ? '❌' : mdHit ? '⚠️' : '✅'
    }`,
  );
  for (const o of m.realOverflow) console.log(`      ⚠️ <${o.tag}> 溢出 ${o.over}px  ${o.cls}`);
  for (const c of m.clippedWithoutTitle) {
    console.log(`      ⚠️ 被截断且没有 title（内容读不到）: ${c.cls} — "${c.text}"`);
  }
  if (mdHit) {
    for (const line of formatMarkdownReport(markdown, '      ')) console.log(line);
  }
  if (errs > 0) console.log(`      ❌ 控制台错误 ${errs} 条`);
  if (bad > 0) console.log(`      ❌ 4xx/5xx ${bad} 条`);
}

console.log(
  problems === 0
    ? `\n✅ ${ROUTES.length} 个页面没有客观异常`
    : `\n❌ ${problems} 个页面有问题（见上）`,
);
/*
 * markdown 维度**单列一行**：即使它默认不参与退出码，也绝不允许它被摘要遮掉 ——
 * "不明说"正是这次要修掉的那类假绿。
 */
if (mdPages.length > 0) {
  const detail = mdPages
    .map((p) => `${p.route} title ${p.titleHits}${p.innerTextMatches > 0 ? ` / 正文 ${p.innerTextMatches}` : ''}`)
    .join(' · ');
  const total = mdPages.reduce((n, p) => n + p.titleHits + p.innerTextMatches, 0);
  console.log(`\n⚠️ markdown 残留：${mdPages.length} 个页面、共 ${total} 处 —— ${detail}`);
  console.log(
    mdGate
      ? '    （已计入退出码：--markdown-gate / AQ_UI_MARKDOWN_GATE 生效中）'
      : '    （**默认不计入退出码**：判据本身有效，加 --markdown-gate 或 AQ_UI_MARKDOWN_GATE=1 即可让它失败）',
  );
}
/* 判据抓不到什么，每次都说一遍 —— 读一个绿灯的人必须同时知道它没证明什么。 */
console.log('\n  本判据仍**抓不到**：');
for (const s of MARKDOWN_BLIND_SPOTS) console.log(`    · ${s}`);
console.log('');
await browser.close();
process.exit(problems === 0 ? 0 : 1);
